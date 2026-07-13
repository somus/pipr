import type { Task } from "@usepipr/sdk";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import type { CodeHostAdapter, CodeHostStatus, CodeHostStatusState } from "../hosts/types.js";
import type { RuntimeCheckSink, RuntimeTaskCheckResult } from "../review/task/task-runtime.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";

export const genericCheckFailureSummary = "pipr failed; see runner logs for details.";

export type StartedRuntimeChecks = {
  event: ChangeRequestEventContext;
  adapter: CodeHostAdapter;
  tasks: Task<unknown>[];
  outcomes: Map<string, RuntimeTaskCheckResult>;
  taskRuns: Map<string, CodeHostStatus>;
  aggregate?: CodeHostStatus;
  sink: RuntimeCheckSink;
  log?: RuntimeLog;
};

export type FinalizeRuntimeCheckOptions = {
  skipped?: boolean;
  forceFailureSummary?: string;
  preserveTaskOutcomes?: boolean;
};

export async function startRuntimeChecks(options: {
  adapter: CodeHostAdapter;
  event: ChangeRequestEventContext;
  plan: RuntimePlan;
  taskName?: string;
  selectedTasks: Task<unknown>[];
  log?: RuntimeLog;
}): Promise<StartedRuntimeChecks | undefined> {
  if (!canStartRuntimeChecks(options)) {
    return undefined;
  }
  const tasks = options.selectedTasks;
  const aggregate = options.plan.checks?.aggregate;
  const aggregateName =
    aggregate === undefined || aggregate === false || aggregate.enabled === false
      ? undefined
      : (aggregate.name ?? "all");
  const taskRuns = new Map<string, CodeHostStatus>();
  if (!aggregateName && !tasks.some((task) => taskCheckSettings(task).individual)) {
    return undefined;
  }
  const outcomes = new Map<string, RuntimeTaskCheckResult>();
  const started: StartedRuntimeChecks = {
    event: options.event,
    adapter: options.adapter,
    tasks,
    outcomes,
    taskRuns,
    log: options.log,
    sink: {
      setTaskResult(result) {
        outcomes.set(result.taskName, result);
      },
    },
  };
  try {
    await startTaskCheckRuns(started);
    if (aggregateName) {
      started.aggregate = await createStatusOrThrow(
        started,
        aggregateName,
        "pipr review is running.",
      );
      started.log?.info("status created", { name: aggregateName, kind: "aggregate" });
    }
  } catch (error) {
    await finalizeRuntimeChecks(started, {
      forceFailureSummary: genericCheckFailureSummary,
    }).catch(() => undefined);
    throw error;
  }
  return started;
}

export async function finalizeRuntimeChecks(
  checks: StartedRuntimeChecks | undefined,
  options: FinalizeRuntimeCheckOptions,
): Promise<void> {
  if (!checks?.adapter.statuses) {
    return;
  }
  const taskResults = checks.tasks.map((task) =>
    taskCheckResultForFinalization(task, checks.outcomes.get(task.name), options),
  );
  const taskError = await updateTaskCheckRuns(checks, taskResults);
  const aggregateError = await updateAggregateCheckRun(checks, taskResults, options);
  const firstError = taskError ?? aggregateError;
  if (firstError !== undefined) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
}

function canStartRuntimeChecks(options: {
  adapter: CodeHostAdapter;
  event: ChangeRequestEventContext;
  taskName?: string;
}): boolean {
  return (
    options.taskName === undefined &&
    options.adapter.capabilities.statuses &&
    Boolean(options.adapter.statuses?.isAvailable(options.event))
  );
}

async function startTaskCheckRuns(started: StartedRuntimeChecks): Promise<void> {
  for (const task of started.tasks) {
    const settings = taskCheckSettings(task);
    if (!settings.individual) {
      continue;
    }
    const run = await createStatusOrThrow(started, settings.name, "pipr task is running.");
    started.taskRuns.set(task.name, run);
    started.log?.info("status created", {
      name: settings.name,
      kind: "task",
      task: task.name,
    });
  }
}

async function createStatusOrThrow(
  checks: StartedRuntimeChecks,
  name: string,
  summary: string,
): Promise<CodeHostStatus> {
  try {
    const statuses = checks.adapter.statuses;
    if (!statuses) {
      throw new Error("status publication is not available");
    }
    return await statuses.upsert({ change: checks.event, name, state: "pending", summary });
  } catch (error) {
    throw statusPermissionError(error);
  }
}

function statusPermissionError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(
    `Unable to publish code host status. Check the adapter credential scopes. ${message}`,
  );
}

async function updateTaskCheckRuns(
  checks: StartedRuntimeChecks,
  taskResults: RuntimeTaskCheckResult[],
): Promise<unknown> {
  let firstError: unknown;
  for (const task of checks.tasks) {
    const run = checks.taskRuns.get(task.name);
    if (!run) {
      continue;
    }
    const result = taskResults.find((item) => item.taskName === task.name);
    if (!result) {
      continue;
    }
    firstError ??= await updateCheckRunOrError(checks, run, result);
  }
  return firstError;
}

async function updateAggregateCheckRun(
  checks: StartedRuntimeChecks,
  taskResults: RuntimeTaskCheckResult[],
  options: FinalizeRuntimeCheckOptions,
): Promise<unknown> {
  if (checks.aggregate) {
    return await updateCheckRunOrError(
      checks,
      checks.aggregate,
      aggregateCheckConclusion(checks.tasks, taskResults, options),
    );
  }
  return undefined;
}

async function updateCheckRunOrError(
  checks: StartedRuntimeChecks,
  checkRun: CodeHostStatus,
  result: { conclusion: Exclude<CodeHostStatusState, "pending">; summary?: string },
): Promise<unknown> {
  try {
    await checks.adapter.statuses?.upsert({
      change: checks.event,
      name: checkRun.name,
      status: checkRun,
      state: result.conclusion,
      summary: result.summary,
    });
    checks.log?.info("status finalized", {
      name: checkRun.name,
      conclusion: result.conclusion,
      summary: result.summary,
    });
    return undefined;
  } catch (error) {
    checks.log?.warning("status finalize failed", {
      name: checkRun.name,
      error: error instanceof Error ? error.message : String(error),
    });
    return error;
  }
}

function taskCheckResultForFinalization(
  task: Task<unknown>,
  result: RuntimeTaskCheckResult | undefined,
  options: FinalizeRuntimeCheckOptions,
): RuntimeTaskCheckResult {
  if (options.skipped) {
    return { taskName: task.name, conclusion: "neutral", summary: "No task matched this run." };
  }
  if (options.forceFailureSummary && options.preserveTaskOutcomes && result) {
    return result;
  }
  if (options.forceFailureSummary) {
    return { taskName: task.name, conclusion: "failure", summary: options.forceFailureSummary };
  }
  return result ?? { taskName: task.name, conclusion: "success" };
}

function aggregateCheckConclusion(
  tasks: Task<unknown>[],
  results: RuntimeTaskCheckResult[],
  options: { skipped?: boolean; forceFailureSummary?: string },
): { conclusion: Exclude<CodeHostStatusState, "pending">; summary: string } {
  if (options.skipped || tasks.length === 0) {
    return { conclusion: "neutral", summary: "No pipr tasks matched this run." };
  }
  if (options.forceFailureSummary) {
    return { conclusion: "failure", summary: options.forceFailureSummary };
  }
  const participating = tasks.filter((task) => taskCheckSettings(task).aggregate);
  if (participating.length === 0) {
    return { conclusion: "neutral", summary: "No pipr task checks participated." };
  }
  const failedRequired = participating.some((task) => {
    const settings = taskCheckSettings(task);
    const result = results.find((item) => item.taskName === task.name);
    return settings.required && result?.conclusion === "failure";
  });
  return failedRequired
    ? { conclusion: "failure", summary: "One or more required pipr tasks failed." }
    : { conclusion: "success", summary: "All required pipr tasks completed." };
}

function taskCheckSettings(task: Task<unknown>): {
  individual: boolean;
  aggregate: boolean;
  name: string;
  required: boolean;
} {
  const check = task.check;
  if (check === false) {
    return { individual: false, aggregate: false, name: task.name, required: false };
  }
  const options = typeof check === "object" ? check : undefined;
  return {
    individual: options !== undefined && options.enabled !== false,
    aggregate: true,
    name: options?.name ?? task.name,
    required: options?.required ?? true,
  };
}
