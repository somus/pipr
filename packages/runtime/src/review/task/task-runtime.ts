import type {
  Agent,
  DiffManifestOptions,
  PiprRunContext,
  PiprRunSummary,
  SecretRef,
  TaskContext,
} from "@usepipr/sdk";
import type { RuntimePlan, RuntimeTask } from "@usepipr/sdk/internal";
import { uniq } from "lodash-es";
import type { ConfigVersionCompatibility } from "../../config/version-compat.js";
import { type BuildDiffManifestOptions, buildDiffManifest } from "../../diff/diff.js";
import { cloneDiffManifest, projectDiffManifest } from "../../diff/manifest-projection.js";
import { enrichDiffManifestWithStructure } from "../../diff/manifest-structure.js";
import {
  createDiffStructuralAnalysisLoader,
  type DiffStructuralAnalysisLoader,
} from "../../diff/structural-analysis.js";
import { selectRuntimeTasks } from "../../host-run/entry-dispatch.js";
import type { RunObserver } from "../../observability/types.js";
import { diffContextCoverageArtifact } from "../../pi/diff-context-coverage.js";
import { type RuntimeLog, runLoggedPhase } from "../../shared/logging.js";
import type { SecretRedactor } from "../../shared/secret-redaction.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  PiprConfig,
  ProviderConfig,
  ReviewResult,
  ValidatedReview,
} from "../../types.js";
import { parseDiffManifest, parsePiprConfig, parseProviderConfig } from "../../types.js";
import { type AgentRunBudget, createAgentRunBudget } from "../agent/agent-run-budget.js";
import {
  type PiRunner,
  type PiRunStats,
  resolveProvider,
  runReviewAgent,
} from "../agent/review-run.js";
import { type InlineCommentDraft, type PublicationPlan, runtimeVersion } from "../comment.js";
import { buildCommentPublishingPlan } from "../comment-publishing.js";
import { type PriorReviewState, priorReviewStateForSelectedTasks } from "../prior-state.js";
import type { ReviewProgressSink } from "../progress.js";
import { redactCommandPublication, redactReviewPublication } from "../publication-redaction.js";
import { validateReviewFindings, validateReviewResult } from "../review.js";
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
  recordDroppedFindings,
  reviewStatsForRuns,
  runSummaryStatsFields,
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
  selectedTasks?: readonly RuntimeTask[];
  emptyTasksReason?: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  piExecutable?: string;
  piAgentDir?: string;
  piRunner?: PiRunner;
  structuralHeadRef?: string;
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
  runTrigger?: Exclude<PiprRunContext["trigger"], "verifier">;
  runObserver?: RunObserver;
  workflowUrl?: string;
  progress?: ReviewProgressSink & {
    recordStats(stats: import("../review-stats.js").ReviewStats | undefined): void;
  };
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
      run: PiprRunSummary;
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
      run: PiprRunSummary;
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
  registerProviderSecrets(config, options);
  const provider = taskRuntimeProvider(options, config);
  await options.progress?.transition("building-diff");
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
  await recordRuntimeArtifact(options, {
    kind: "diff-manifest",
    name: "diff-manifest.json",
    mediaType: "application/json",
    content: JSON.stringify(diffManifest, null, 2),
    sensitive: true,
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
  const run: PiprRunContext = Object.freeze({
    id: runId,
    trigger: taskRunTrigger(options),
  });
  const loadedPriorReviewState =
    options.priorReviewState ??
    (await runLoggedPhase(options.log, "load prior review state", async () =>
      options.loadPriorReviewState?.(),
    ));
  const priorMainComment =
    options.priorMainComment ??
    (await runLoggedPhase(options.log, "load prior main comment", async () =>
      options.loadPriorMainComment?.(),
    ));
  const priorReviewState = priorReviewStateForSelectedTasks(loadedPriorReviewState, selectedTasks);
  const piRuns: PiRunStats[] = [];
  const agentRunBudget = createAgentRunBudget(config.limits?.maxAgentRuns);
  const structuralAnalysis = createDiffStructuralAnalysisLoader({
    manifest: diffManifest,
    workspace: options.workspace,
    headRef: options.structuralHeadRef,
    env: options.env,
    log: options.log,
  });
  let structuralManifestPromise: Promise<DiffManifest> | undefined;
  const structuralManifest = () => {
    structuralManifestPromise ??= structuralAnalysis().then((analysis) =>
      enrichDiffManifestWithStructure(diffManifest, analysis),
    );
    return structuralManifestPromise;
  };
  const runtimeOptions = {
    ...options,
    priorReviewState,
    priorMainComment,
    run,
    agentRunBudget,
    structuralAnalysis,
    structuralToolsEnabled: options.structuralHeadRef === undefined,
    structuralManifest,
    piRunSink(run: PiRunStats) {
      piRuns.push(run);
      options.progress?.recordStats(reviewStatsForRuns(piRuns, Date.now() - runtimeStarted));
    },
  };

  const manifestCache = new Map<string, DiffManifest>();
  await options.progress?.transition("running-review-tasks");
  const taskResults = await executeSelectedTasks({
    tasks,
    runtimeOptions: options,
    context: {
      ...runtimeOptions,
      config,
      provider,
      diffManifest,
      manifestCache,
    },
  });
  options.log?.info("agent run budget", {
    used: agentRunBudget.reservedAgentRuns,
    limit: agentRunBudget.maxAgentRuns,
  });
  const taskChecks = taskResults.map((result) =>
    runtimeTaskCheckResult(result.taskName, result.output.check ?? { conclusion: "success" }),
  );
  const failedTask = taskResults.find((result) => result.error !== undefined);
  if (failedTask) {
    publishFailedRunTaskChecks(options, taskChecks);
    await recordDiffContextCoverageArtifact(options, piRuns);
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
  const commandDurationMs = Date.now() - runtimeStarted;
  const commandResponse = commandResponseResultFromOutput({
    provider,
    diffManifest,
    output,
    taskChecks,
    run: runSummary({
      options,
      run,
      selectedTasks,
      durationMs: commandDurationMs,
      models: output.providerModels.length > 0 ? uniq(output.providerModels) : [provider.model],
      stats: reviewStatsForRuns(piRuns, commandDurationMs),
    }),
    commandInvocation: options.commandInvocation,
    secretRedactor: options.secretRedactor,
  });
  if (commandResponse) {
    publishTaskChecks(options.checkSink, commandResponse.taskChecks);
    await recordDiffContextCoverageArtifact(options, piRuns);
    return commandResponse;
  }
  assertReviewCommentOutput(output, options.commandInvocation !== undefined);

  await options.progress?.transition("validating-review");
  const main = reviewMainComment(output);
  const review = collectedReview(output, main);
  const finalValidated = validateReviewResult(review, diffManifest, {
    expectedHeadSha: options.event.change.head.sha,
    pathScopeForFinding: (_finding, index) => output.findings[index]?.paths,
  });
  const validated: ValidatedReview = {
    ...finalValidated,
    droppedFindings: [...output.droppedFindings, ...finalValidated.droppedFindings],
  };
  const verifier = await runSynchronizeVerifier({
    options,
    config,
    provider,
    diffManifest,
    priorReviewState,
    run,
    piRunSink: runtimeOptions.piRunSink,
    agentRunBudget,
  });
  const durationMs = Date.now() - runtimeStarted;
  const stats = reviewStatsForRuns(piRuns, durationMs);
  const models = reviewProviderModels(output, verifier.providerModels, provider.model);
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
      providerModels: models,
      selectedTasks,
      failedTasks: [],
      validFindings: validated.validFindings.length,
      droppedFindings: validated.droppedFindings.length,
      ...(stats ? { stats } : {}),
      workflowUrl: options.workflowUrl,
    },
  });
  const publicationPlan = publishing.publicationPlan;
  publishTaskChecks(options.checkSink, redactedPublication.taskChecks);
  options.log?.info("review validated", {
    validFindings: validated.validFindings.length,
    droppedFindings: validated.droppedFindings.length,
    inlineDrafts: publishing.inlineCommentDrafts.length,
    threadActions: verifier.threadActions.length,
    ...(stats?.diffContextCoverage
      ? {
          contextFilesTotal: stats.diffContextCoverage.files.total,
          contextFilesCovered: stats.diffContextCoverage.files.covered,
          contextRangesTotal: stats.diffContextCoverage.ranges.total,
          contextRangesCovered: stats.diffContextCoverage.ranges.covered,
        }
      : {}),
  });
  await recordDiffContextCoverageArtifact(options, piRuns);
  await Promise.all([
    recordRuntimeArtifact(options, {
      kind: "output",
      name: "review-output.json",
      mediaType: "application/json",
      content: JSON.stringify(
        { review: redactedPublication.validated.review, mainComment: publicationPlan.mainComment },
        null,
        2,
      ),
      sensitive: true,
    }),
    recordRuntimeArtifact(options, {
      kind: "validation",
      name: "validation.json",
      mediaType: "application/json",
      content: JSON.stringify(redactedPublication.validated, null, 2),
      sensitive: true,
    }),
    recordRuntimeArtifact(options, {
      kind: "publication-plan",
      name: "publication-plan.json",
      mediaType: "application/json",
      content: JSON.stringify(publicationPlan, null, 2),
      sensitive: true,
    }),
  ]);

  return {
    kind: "review",
    run: runSummary({ options, run, selectedTasks, durationMs, models, stats }),
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

function registerProviderSecrets(config: PiprConfig, options: RunTaskRuntimeOptions): void {
  const env = options.env ?? process.env;
  for (const provider of config.providers) {
    if (!provider.apiKeyEnv) continue;
    const value = env[provider.apiKeyEnv];
    if (!value) continue;
    options.log?.addSecret(value);
    options.secretRedactor?.addSecret(value);
    options.runObserver?.registerSecret?.(value);
  }
}

async function recordRuntimeArtifact(
  options: Pick<RunTaskRuntimeOptions, "runObserver" | "log">,
  artifact: Parameters<NonNullable<RunObserver["recordArtifact"]>>[0],
): Promise<void> {
  try {
    await options.runObserver?.recordArtifact?.(artifact);
  } catch (error) {
    options.log?.warning("run capture artifact failed", {
      kind: artifact.kind,
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
}

async function recordDiffContextCoverageArtifact(
  options: Pick<RunTaskRuntimeOptions, "runObserver" | "log">,
  piRuns: readonly PiRunStats[],
): Promise<void> {
  const content = diffContextCoverageArtifact(
    piRuns.map((piRun) => piRun.diffContextCoverage).filter((coverage) => coverage !== undefined),
  );
  if (!content) return;
  await recordRuntimeArtifact(options, {
    kind: "diff-context-coverage",
    name: "diff-context-coverage.json",
    mediaType: "application/json",
    content,
    sensitive: true,
  });
}

function taskRuntimeProvider(options: RunTaskRuntimeOptions, config: PiprConfig): ProviderConfig {
  return options.providerOverride
    ? parseProviderConfig(options.providerOverride)
    : resolveProvider(config, config.defaultProvider);
}

function taskRunTrigger(
  options: Pick<RunTaskRuntimeOptions, "commandInvocation" | "runTrigger">,
): PiprRunContext["trigger"] {
  if (options.runTrigger) {
    return options.runTrigger;
  }
  return options.commandInvocation ? "command" : "change-request";
}

function reviewMainComment(output: OutputStateWithComment): string {
  return typeof output.comment.value === "string"
    ? output.comment.value
    : (output.comment.value.main ?? "Review completed.");
}

function reviewProviderModels(
  output: OutputState,
  verifierModels: string[],
  fallbackModel: string,
): string[] {
  return output.providerModels.length + verifierModels.length > 0
    ? uniq([...output.providerModels, ...verifierModels])
    : [fallbackModel];
}

type TaskExecutionResult = {
  taskName: string;
  output: OutputState;
  error?: unknown;
};

async function executeSelectedTasks(options: {
  tasks: readonly RuntimeTask[];
  runtimeOptions: RunTaskRuntimeOptions;
  context: Omit<Parameters<typeof createTaskContext>[0], "output" | "taskName" | "taskOrder">;
}): Promise<TaskExecutionResult[]> {
  return Promise.all(
    options.tasks.map(async (task, taskOrder): Promise<TaskExecutionResult> => {
      const output = createOutputState();
      const started = Date.now();
      const taskId = String(taskOrder);
      options.runtimeOptions.log?.info("task start", { task: task.name, order: taskOrder });
      options.runtimeOptions.progress?.work({
        type: "task-started",
        taskId,
        taskName: task.name,
        taskOrder,
      });
      try {
        await task.handler(
          createTaskContext({
            ...options.context,
            output,
            taskName: task.name,
            taskOrder,
          }),
          task.name === options.runtimeOptions.taskName
            ? options.runtimeOptions.taskInput
            : undefined,
        );
        options.runtimeOptions.log?.info("task ok", {
          task: task.name,
          durationMs: Date.now() - started,
          findings: output.findings.length,
          providerModels: output.providerModels,
          repairAttempted: output.repairAttempted,
        });
        options.runtimeOptions.progress?.work({
          type: "task-finished",
          taskId,
          taskName: task.name,
          outcome: "completed",
        });
        return { taskName: task.name, output };
      } catch (error) {
        const check = {
          conclusion: "failure" as const,
          summary: genericTaskFailureSummary,
        };
        options.runtimeOptions.log?.error("task failed", {
          task: task.name,
          durationMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        });
        if (options.runtimeOptions.log?.debugEnabled && error instanceof Error && error.stack) {
          options.runtimeOptions.log.text("debug", "error stack", error.stack);
        }
        options.runtimeOptions.progress?.work({
          type: "task-finished",
          taskId,
          taskName: task.name,
          outcome: "failed",
        });
        return { taskName: task.name, output: { ...output, check }, error };
      }
    }),
  );
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

function runSummary(options: {
  options: RunTaskRuntimeOptions;
  run: PiprRunContext;
  selectedTasks: string[];
  durationMs: number;
  models: string[];
  stats: ReturnType<typeof reviewStatsForRuns>;
}): PiprRunSummary {
  return {
    ...options.run,
    baseSha: options.options.event.change.base.sha,
    headSha: options.options.event.change.head.sha,
    tasks: options.selectedTasks,
    durationMs: options.durationMs,
    models: options.models,
    ...runSummaryStatsFields(options.stats),
  };
}

function commandResponseResultFromOutput(options: {
  provider: ProviderConfig;
  diffManifest: DiffManifest;
  output: OutputState;
  taskChecks: RuntimeTaskCheckResult[];
  commandInvocation?: RuntimeCommandInvocation;
  secretRedactor?: SecretRedactor;
  run: PiprRunSummary;
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
  run: PiprRunContext;
  piRunSink: (run: PiRunStats) => void;
  agentRunBudget: AgentRunBudget;
}): Promise<Awaited<ReturnType<typeof runInternalVerifier>>> {
  if (
    options.options.event.rawAction !== "synchronize" &&
    options.options.event.rawAction !== "synchronized"
  ) {
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
    piAgentDir: options.options.piAgentDir,
    piRunner: options.options.piRunner,
    log: options.options.log,
    diffManifest: options.diffManifest,
    priorReviewState: options.priorReviewState,
    threadContexts:
      (await runLoggedPhase(options.options.log, "load inline thread contexts", async () =>
        options.options.loadInlineThreadContexts?.(),
      )) ?? [],
    mode: { kind: "synchronize" },
    run: options.run,
    piRunSink: options.piRunSink,
    runObserver: options.options.runObserver,
    agentRunBudget: options.agentRunBudget,
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
    run: PiprRunContext;
    piRunSink: (run: PiRunStats) => void;
    agentRunBudget: AgentRunBudget;
    structuralAnalysis: DiffStructuralAnalysisLoader;
    structuralManifest: () => Promise<DiffManifest>;
  },
): TaskContext {
  const repositorySlugParts = options.event.repository.slug.split("/");
  let reviewerOrder = 0;
  let taskContext: TaskContext;
  taskContext = {
    run: options.run,
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
        const manifest = projectDiffManifest(await options.structuralManifest(), manifestOptions);
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
        const resolvedAgent = options.plan.resolveAgent(agent);
        const currentReviewerOrder = reviewerOrder++;
        const reviewerName = resolvedAgent.name?.trim() || `Reviewer ${currentReviewerOrder + 1}`;
        const result = await runReviewAgent({
          agent: resolvedAgent,
          input,
          runOptions,
          runtime: {
            ...options,
            taskContext,
            run: options.run,
            piRunSink: options.piRunSink,
            reviewWork: options.progress
              ? {
                  taskId: String(options.taskOrder),
                  reviewerId: `${options.taskOrder}:${currentReviewerOrder}`,
                  reviewerName,
                  reviewerOrder: currentReviewerOrder,
                  emit: (event) => options.progress?.work(event),
                }
              : undefined,
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
      validateFindings(findings, validationOptions) {
        const paths = validationOptions?.paths ?? options.output.findingScopes.get(findings);
        const validated = validateReviewFindings(findings, options.diffManifest, {
          expectedHeadSha: options.event.change.head.sha,
          pathScopeForFinding: () => paths,
        });
        recordDroppedFindings(options.output, validated.droppedFindings);
        if (paths) {
          options.output.findingScopes.set(validated.validFindings, paths);
        }
        return validated;
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

function agentOutputForTaskContext<Input, Output>(
  _agent: Agent<Input, Output>,
  value: unknown,
): Output {
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
  options.runObserver?.registerSecret?.(value);
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
  run: PiprRunSummary;
}): ReviewRuntimeResult {
  const redacted = redactCommandPublication({
    body: options.commandResponse.value,
    taskChecks: options.taskChecks,
    redactor: options.secretRedactor,
  });
  return {
    kind: "command-response",
    run: options.run,
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
