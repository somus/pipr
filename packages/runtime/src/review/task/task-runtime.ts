import type { Agent, DiffManifestOptions, SecretRef, Task, TaskContext } from "@usepipr/sdk";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import { uniq } from "lodash-es";
import type { ConfigVersionCompatibility } from "../../config/version-compat.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../../diff/diff.js";
import { cloneDiffManifest, projectDiffManifest } from "../../diff/manifest-projection.js";
import { selectRuntimeTasks } from "../../host-run/entry-dispatch.js";
import type { RuntimeLog } from "../../shared/logging.js";
import type { SecretRedactor } from "../../shared/secret-redactor.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  ReviewResult,
  ValidatedReview,
} from "../../types.js";
import { parseDiffManifest, parsePiprConfig, parseProviderConfig } from "../../types.js";
import {
  type PiRunner,
  type PiRunStats,
  resolveProvider,
  runReviewAgent,
} from "../agent/review-run.js";
import { type InlineCommentDraft, type PublicationPlan, runtimeVersion } from "../comment.js";
import { buildCommentPublishingPlan } from "../comment-publishing.js";
import { type PriorReviewState, priorReviewStateForSelectedTasks } from "../prior-state.js";
import { redactCommandPublication, redactReviewPublication } from "../publication-redaction.js";
import { validateReviewResult } from "../review.js";
import { type RuntimeCommandInvocation, stableReviewRunId } from "../run-identity.js";
import { runInternalVerifier } from "../verifier.js";
import {
  type CommandResponseContribution,
  collectCommandResponse,
  collectComment,
  collectedReview,
  createCheckHandle,
  createOutputState,
  mergeTaskOutputs,
  type OutputState,
  type OutputStateWithComment,
  priorReviewForTask,
  type RuntimeCheckSink,
  type RuntimeTaskCheckResult,
  reviewStatsForRuns,
  runtimeTaskCheckResult,
  trackResultFindingScope,
} from "./task-output.js";

export type { PiRunner } from "../agent/review-run.js";
export type { RuntimeCommandInvocation } from "../run-identity.js";
export type { RuntimeCheckSink, RuntimeTaskCheckResult } from "./task-output.js";
export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;

const genericTaskFailureSummary = "Task failed; see logs for details.";

export type RunTaskRuntimeOptions = {
  workspace: string;
  config: PiprConfig;
  event: ChangeRequestEventContext;
  plan: RuntimePlan;
  versionCompatibility?: ConfigVersionCompatibility;
  env?: NodeJS.ProcessEnv;
  providerOverride?: ProviderConfig;
  taskName?: string;
  taskInput?: unknown;
  selectedTasks?: readonly Task<unknown>[];
  emptyTasksReason?: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  piExecutable?: string;
  piRunner?: PiRunner;
  diffManifestBuilder?: DiffManifestBuilder;
  priorReviewState?: PriorReviewState;
  priorMainComment?: string;
  loadPriorReviewState?: () => Promise<PriorReviewState | undefined>;
  loadPriorMainComment?: () => Promise<string | undefined>;
  loadInlineThreadContexts?: () => Promise<import("../../hosts/types.js").InlineThreadContext[]>;
  checkSink?: RuntimeCheckSink;
  commandInvocation?: RuntimeCommandInvocation;
  log?: RuntimeLog;
  taskLog?: TaskContext["log"];
  secretRedactor?: SecretRedactor;
};

type ReviewRuntimeBaseResult = {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  taskChecks: RuntimeTaskCheckResult[];
  repairAttempted: boolean;
};

export type ReviewRuntimeResult =
  | (ReviewRuntimeBaseResult & {
      kind: "review";
      review: ReviewResult;
      validated: ValidatedReview;
      publicationPlan: PublicationPlan;
      mainComment: string;
      inlineCommentDrafts: InlineCommentDraft[];
      commandResponse?: never;
    })
  | (ReviewRuntimeBaseResult & {
      kind: "skipped";
      skipReason: string;
      review: ReviewResult;
      validated: ValidatedReview;
      publicationPlan: PublicationPlan;
      mainComment: string;
      inlineCommentDrafts: InlineCommentDraft[];
      commandResponse?: never;
    })
  | (ReviewRuntimeBaseResult & {
      kind: "command-response";
      commandResponse: {
        commandName: string;
        line: string;
        arguments: Record<string, string>;
        body: string;
      };
      review?: never;
      validated?: never;
      publicationPlan?: never;
      mainComment?: never;
      inlineCommentDrafts?: never;
    });

export async function runTaskRuntime(options: RunTaskRuntimeOptions): Promise<ReviewRuntimeResult> {
  const runtimeStarted = Date.now();
  const config = parsePiprConfig(options.config);
  const provider = options.providerOverride
    ? parseProviderConfig(options.providerOverride)
    : resolveProvider(config, config.defaultProvider);
  const diffManifest = parseDiffManifest(
    (options.diffManifestBuilder ?? buildDiffManifest)({
      cwd: options.workspace,
      baseSha: options.event.change.base.sha,
      headSha: options.event.change.head.sha,
    }),
  );
  options.log?.info("diff manifest", {
    base: diffManifest.baseSha.slice(0, 12),
    head: diffManifest.headSha.slice(0, 12),
    mergeBase: diffManifest.mergeBaseSha.slice(0, 12),
    files: diffManifest.files.length,
    hunks: diffManifest.files.reduce((sum, file) => sum + file.hunks.length, 0),
    ranges: diffManifest.files.reduce((sum, file) => sum + file.commentableRanges.length, 0),
    additions: diffManifest.files.reduce((sum, file) => sum + file.additions, 0),
    deletions: diffManifest.files.reduce((sum, file) => sum + file.deletions, 0),
    excluded: diffManifest.files.filter((file) => file.excludedReason !== undefined).length,
  });
  const tasks = [
    ...(options.selectedTasks ??
      selectRuntimeTasks({
        plan: options.plan,
        event: options.event,
        taskName: options.taskName,
      })),
  ];
  if (tasks.length === 0) {
    options.log?.info("task runtime skipped", { reason: "no-matched-tasks" });
    return skippedTaskRuntimeResult({
      config,
      diffManifest,
      event: options.event,
      provider,
      reason: options.emptyTasksReason,
      taskName: options.taskName,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      versionCompatibility: options.versionCompatibility,
    });
  }
  const selectedTasks = tasks.map((task) => task.name);
  options.log?.info("task runtime start", { selectedTasks, taskCount: tasks.length });
  const runId = stableReviewRunId({
    event: options.event,
    selectedTasks,
    trustedConfigSha: options.trustedConfigSha,
    trustedConfigHash: options.trustedConfigHash,
    commandInvocation: options.commandInvocation,
  });
  const loadedPriorReviewState =
    options.priorReviewState ?? (await options.loadPriorReviewState?.());
  const priorMainComment = options.priorMainComment ?? (await options.loadPriorMainComment?.());
  const priorReviewState = priorReviewStateForSelectedTasks(loadedPriorReviewState, selectedTasks);
  const piRuns: PiRunStats[] = [];
  const runtimeOptions = {
    ...options,
    priorReviewState,
    priorMainComment,
    runId,
    piRunSink(run: PiRunStats) {
      piRuns.push(run);
    },
  };

  const manifestCache = new Map<string, DiffManifest>();
  const taskResults = await Promise.all(
    tasks.map(async (task, taskOrder) => {
      const output = createOutputState();
      const started = Date.now();
      options.log?.info("task start", { task: task.name, order: taskOrder });
      try {
        await task.handler(
          createTaskContext({
            ...runtimeOptions,
            config,
            provider,
            diffManifest,
            manifestCache,
            output,
            taskName: task.name,
            taskOrder,
          }),
          task.name === options.taskName ? options.taskInput : undefined,
        );
        options.log?.info("task ok", {
          task: task.name,
          durationMs: Date.now() - started,
          findings: output.findings.length,
          providerModels: output.providerModels,
          repairAttempted: output.repairAttempted,
        });
        return { taskName: task.name, output };
      } catch (error) {
        const check = {
          conclusion: "failure" as const,
          summary: genericTaskFailureSummary,
        };
        options.log?.error("task failed", {
          task: task.name,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.log?.debugEnabled && error instanceof Error && error.stack) {
          options.log.text("debug", "error stack", error.stack);
        }
        return { taskName: task.name, output: { ...output, check }, error };
      }
    }),
  );
  const taskChecks = taskResults.map((result) =>
    runtimeTaskCheckResult(result.taskName, result.output.check ?? { conclusion: "success" }),
  );
  const failedTask = taskResults.find((result) => result.error !== undefined);
  if (failedTask) {
    publishFailedRunTaskChecks(options, taskChecks);
    throw failedTask.error instanceof Error
      ? failedTask.error
      : new Error(String(failedTask.error));
  }
  const output = mergeTaskOutputs(taskResults);
  options.log?.info("task runtime collected", {
    findings: output.findings.length,
    providerModels: output.providerModels,
    repairAttempted: output.repairAttempted,
  });
  const commandResponse = commandResponseResultFromOutput({
    provider,
    diffManifest,
    output,
    taskChecks,
    commandInvocation: options.commandInvocation,
    secretRedactor: options.secretRedactor,
  });
  if (commandResponse) {
    publishTaskChecks(options.checkSink, commandResponse.taskChecks);
    return commandResponse;
  }
  assertReviewCommentOutput(output, options.commandInvocation !== undefined);

  const main =
    typeof output.comment.value === "string"
      ? output.comment.value
      : (output.comment.value.main ?? "Review completed.");
  const review = collectedReview(output, main);
  const validated = validateReviewResult(review, diffManifest, {
    expectedHeadSha: options.event.change.head.sha,
    pathScopeForFinding: (_finding, index) => output.findings[index]?.paths,
  });
  const verifier = await runSynchronizeVerifier({
    options,
    config,
    provider,
    diffManifest,
    priorReviewState,
    runId,
    piRunSink: runtimeOptions.piRunSink,
  });
  const stats = reviewStatsForRuns(piRuns, Date.now() - runtimeStarted);
  const redactedPublication = redactReviewPublication({
    main,
    validated,
    threadActions: verifier.threadActions,
    taskChecks,
    redactor: options.secretRedactor,
  });
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    main: redactedPublication.main,
    validated: redactedPublication.validated,
    manifest: diffManifest,
    maxInlineComments: config.publication.maxInlineComments,
    maxStoredFindings: config.publication.maxStoredFindings,
    showHeader: config.publication.showHeader,
    showFooter: config.publication.showFooter,
    showStats: config.publication.showStats,
    priorReviewState: verifier.priorReviewState,
    threadActions: redactedPublication.threadActions,
    metadata: {
      runtimeVersion,
      configVersion: options.versionCompatibility?.configVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.change.head.sha,
      providerModels:
        output.providerModels.length + verifier.providerModels.length > 0
          ? uniq([...output.providerModels, ...verifier.providerModels])
          : [provider.model],
      selectedTasks,
      failedTasks: [],
      validFindings: validated.validFindings.length,
      droppedFindings: validated.droppedFindings.length,
      ...(stats ? { stats } : {}),
    },
  });
  const publicationPlan = publishing.publicationPlan;
  publishTaskChecks(options.checkSink, redactedPublication.taskChecks);
  options.log?.info("review validated", {
    validFindings: validated.validFindings.length,
    droppedFindings: validated.droppedFindings.length,
    inlineDrafts: publishing.inlineCommentDrafts.length,
    threadActions: verifier.threadActions.length,
  });

  return {
    kind: "review",
    provider,
    diffManifest,
    review: redactedPublication.validated.review,
    validated: redactedPublication.validated,
    publicationPlan,
    mainComment: publicationPlan.mainComment,
    inlineCommentDrafts: publishing.inlineCommentDrafts,
    taskChecks: redactedPublication.taskChecks,
    repairAttempted: output.repairAttempted,
  };
}

function publishFailedRunTaskChecks(
  options: Pick<RunTaskRuntimeOptions, "checkSink" | "secretRedactor">,
  taskChecks: RuntimeTaskCheckResult[],
): void {
  const redacted = redactCommandPublication({
    body: "",
    taskChecks,
    redactor: options.secretRedactor,
  });
  publishTaskChecks(options.checkSink, redacted.taskChecks);
}

function commandResponseResultFromOutput(options: {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  output: OutputState;
  taskChecks: RuntimeTaskCheckResult[];
  commandInvocation?: RuntimeCommandInvocation;
  secretRedactor?: SecretRedactor;
}): ReviewRuntimeResult | undefined {
  const commandResponse = options.output.commandResponse;
  if (!commandResponse) {
    return undefined;
  }
  if (!options.commandInvocation) {
    throw new Error("ctx.command.reply(...) is only available for command-triggered tasks");
  }
  return commandResponseRuntimeResult({
    ...options,
    commandResponse,
    commandInvocation: options.commandInvocation,
  });
}

function assertReviewCommentOutput(
  output: OutputState,
  hasCommandInvocation: boolean,
): asserts output is OutputStateWithComment {
  if (output.comment) {
    return;
  }
  throw new Error(
    hasCommandInvocation
      ? "ctx.comment(...) or ctx.command.reply(...) must be called exactly once per selected run"
      : "ctx.comment(...) must be called exactly once per selected run",
  );
}

async function runSynchronizeVerifier(options: {
  options: RunTaskRuntimeOptions;
  config: PiprConfig;
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  priorReviewState: PriorReviewState | undefined;
  runId: string;
  piRunSink: (run: PiRunStats) => void;
}): Promise<Awaited<ReturnType<typeof runInternalVerifier>>> {
  if (options.options.event.rawAction !== "synchronize") {
    return {
      priorReviewState: options.priorReviewState,
      threadActions: [],
      providerModels: [],
    };
  }
  const config = options.config;
  return await runInternalVerifier({
    workspace: options.options.workspace,
    config,
    event: options.options.event,
    provider: options.provider,
    verifierProvider: resolveProvider(
      config,
      config.publication.autoResolve.model ?? config.defaultProvider,
    ),
    plan: options.options.plan,
    env: options.options.env,
    piExecutable: options.options.piExecutable,
    piRunner: options.options.piRunner,
    log: options.options.log,
    diffManifest: options.diffManifest,
    priorReviewState: options.priorReviewState,
    threadContexts: (await options.options.loadInlineThreadContexts?.()) ?? [],
    mode: { kind: "synchronize" },
    runId: options.runId,
    piRunSink: options.piRunSink,
  });
}

function createTaskContext(
  options: RunTaskRuntimeOptions & {
    config: PiprConfig;
    provider: ProviderConfig;
    diffManifest: DiffManifest;
    manifestCache: Map<string, DiffManifest>;
    output: OutputState;
    taskName: string;
    taskOrder: number;
    runId: string;
    piRunSink: (run: PiRunStats) => void;
  },
): TaskContext {
  const repositorySlugParts = options.event.repository.slug.split("/");
  let taskContext: TaskContext;
  taskContext = {
    run: { id: options.runId },
    repository: {
      root: options.workspace,
      owner: repositorySlugParts.length > 1 ? repositorySlugParts[0] : undefined,
      name: repositorySlugParts.at(-1) ?? "repo",
    },
    change: {
      number: options.event.change.number,
      title: options.event.change.title,
      description: options.event.change.description,
      url: options.event.change.url,
      author: options.event.change.author,
      base: options.event.change.base,
      head: options.event.change.head,
      isFork: options.event.change.isFork,
      async diffManifest(manifestOptions?: DiffManifestOptions) {
        const key = JSON.stringify(manifestOptions ?? {});
        const cached = options.manifestCache.get(key);
        if (cached) {
          return cloneDiffManifest(cached);
        }
        const manifest = projectDiffManifest(options.diffManifest, manifestOptions);
        options.manifestCache.set(key, manifest);
        return cloneDiffManifest(manifest);
      },
      async changedFiles() {
        return options.diffManifest.files.map((file) => ({
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
        }));
      },
      async currentHeadSha() {
        return options.event.change.head.sha;
      },
    },
    platform: { id: options.event.platform.id },
    command: options.commandInvocation
      ? {
          name: options.commandInvocation.name,
          line: options.commandInvocation.line,
          arguments: { ...options.commandInvocation.arguments },
          async reply(markdown) {
            collectCommandResponse(options.output, markdown, options.taskName);
          },
        }
      : undefined,
    secret(secret) {
      return resolveTaskSecret(secret, options);
    },
    pi: {
      async run(agent, input, runOptions) {
        const result = await runReviewAgent({
          agent,
          input,
          runOptions,
          runtime: {
            ...options,
            taskContext,
            runId: options.runId,
            piRunSink: options.piRunSink,
          },
        });
        options.output.providerModels.push(...result.providerModels);
        if (result.repairAttempted) {
          options.output.repairAttempted = true;
        }
        trackResultFindingScope(options.output, result.value, runOptions?.paths);
        return agentOutputForTaskContext(agent, result.value);
      },
    },
    review: {
      async prior() {
        return priorReviewForTask(options.priorMainComment, options.priorReviewState);
      },
    },
    check: createCheckHandle(options.output),
    async comment(value) {
      collectComment(options.output, value, options.taskName);
    },
    log: options.taskLog ?? console,
  };
  return taskContext;
}

function agentOutputForTaskContext<Output>(_agent: Agent<unknown, Output>, value: unknown): Output {
  // The agent output schema was parsed by runReviewAgent before TaskContext resolves.
  return value as Output;
}

function resolveTaskSecret(secret: SecretRef, options: RunTaskRuntimeOptions): string {
  if (secret.kind !== "pipr.secret" || typeof secret.name !== "string") {
    throw new Error("ctx.secret(...) requires a pipr.secret reference");
  }
  const value = (options.env ?? process.env)[secret.name];
  if (!value) {
    throw new Error(`Missing secret env var: ${secret.name}`);
  }
  options.log?.addSecret(value);
  options.secretRedactor?.addSecret(value);
  return value;
}

function commandResponseRuntimeResult(options: {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  output: OutputState;
  commandResponse: CommandResponseContribution;
  taskChecks: RuntimeTaskCheckResult[];
  commandInvocation: RuntimeCommandInvocation;
  secretRedactor?: SecretRedactor;
}): ReviewRuntimeResult {
  const redacted = redactCommandPublication({
    body: options.commandResponse.value,
    taskChecks: options.taskChecks,
    redactor: options.secretRedactor,
  });
  return {
    kind: "command-response",
    provider: options.provider,
    diffManifest: options.diffManifest,
    taskChecks: redacted.taskChecks,
    repairAttempted: options.output.repairAttempted,
    commandResponse: {
      commandName: options.commandInvocation.name,
      line: options.commandInvocation.line,
      arguments: options.commandInvocation.arguments,
      body: redacted.body,
    },
  };
}

function publishTaskChecks(
  sink: RuntimeCheckSink | undefined,
  checks: readonly RuntimeTaskCheckResult[],
): void {
  for (const check of checks) {
    sink?.setTaskResult(check);
  }
}

function skippedTaskRuntimeResult(options: {
  config: PiprConfig;
  diffManifest: DiffManifest;
  event: ChangeRequestEventContext;
  provider: ProviderConfig;
  reason?: string;
  taskName?: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  versionCompatibility?: ConfigVersionCompatibility;
}): ReviewRuntimeResult {
  const reason =
    options.reason ??
    (options.taskName
      ? `Task '${options.taskName}' was not registered`
      : "No tasks matched the change request event");
  const review: ReviewResult = { summary: { body: reason }, inlineFindings: [] };
  const validated: ValidatedReview = { review, validFindings: [], droppedFindings: [] };
  const publishing = buildCommentPublishingPlan({
    event: options.event,
    main: reason,
    validated,
    manifest: options.diffManifest,
    maxInlineComments: options.config.publication.maxInlineComments,
    maxStoredFindings: options.config.publication.maxStoredFindings,
    showHeader: options.config.publication.showHeader,
    showFooter: options.config.publication.showFooter,
    showStats: options.config.publication.showStats,
    metadata: {
      runtimeVersion,
      configVersion: options.versionCompatibility?.configVersion,
      trustedConfigSha: options.trustedConfigSha,
      trustedConfigHash: options.trustedConfigHash,
      reviewedHeadSha: options.event.change.head.sha,
      providerModels: [options.provider.model],
      selectedTasks: [],
      failedTasks: [],
      validFindings: 0,
      droppedFindings: 0,
    },
  });
  const publicationPlan = publishing.publicationPlan;
  return {
    kind: "skipped",
    skipReason: reason,
    provider: options.provider,
    diffManifest: options.diffManifest,
    review,
    validated,
    publicationPlan,
    mainComment: publicationPlan.mainComment,
    inlineCommentDrafts: [],
    taskChecks: [],
    repairAttempted: false,
  };
}
