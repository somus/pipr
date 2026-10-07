import type { PiprRunContext, PiprRunSummary } from "@usepipr/sdk";
import type { RuntimeTask } from "@usepipr/sdk/internal";
import { uniq } from "lodash-es";
import { registerProviderSecrets } from "../../config/provider-credentials.js";
import type { ConfigVersionCompatibility } from "../../config/version-compat.js";
import { buildDiffManifest } from "../../diff/diff.js";
import { enrichDiffManifestWithStructure } from "../../diff/manifest-structure.js";
import { createDiffStructuralAnalysisLoader } from "../../diff/structural-analysis.js";
import { recordArtifactSafely } from "../../observability/capture-sinks.js";
import type { RunObserver } from "../../observability/types.js";
import { diffContextCoverageArtifact } from "../../pi/diff-context-coverage.js";
import { withPiRunWorkspace } from "../../pi/runner.js";
import type { PiRunner } from "../../pi/types.js";
import type { PriorReviewState, PublicationPlan } from "../../publication/types.js";
import { runLoggedPhase } from "../../shared/logging.js";
import type { SecretRedactor } from "../../shared/secret-redaction.js";
import { runtimeVersion } from "../../shared/version.js";
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
import { resolveProvider } from "../agent/prompt-assembly.js";
import type { PiRunStats } from "../agent/review-run-types.js";
import { deriveReviewFindingOutcomes, findingLedgerContext } from "../finding-ledger.js";
import { priorReviewStateForSelectedTasks } from "../prior-state.js";
import { buildCommentPublishingPlan, type InlineCommentDraft } from "../publication-plan.js";
import { redactCommandPublication, redactReviewPublication } from "../publication-redaction.js";
import { validateReviewResult } from "../review.js";
import { reviewStatsForRuns, runSummaryStatsFields } from "../review-stats.js";
import { type RuntimeCommandInvocation, stableReviewRunId } from "../run-identity.js";
import { runInternalVerifier } from "../verifier.js";
import { selectRuntimeTasks } from "./select-runtime-tasks.js";
import { createTaskContext } from "./task-context.js";
import {
  collectedReview,
  createOutputState,
  findingAttribution,
  mergeTaskOutputs,
  type OutputState,
  type OutputStateWithComment,
  type RuntimeCheckSink,
  type RuntimeTaskCheckResult,
  runtimeTaskCheckResult,
  type TaskRunResult,
} from "./task-output.js";
import type { RunTaskRuntimeOptions } from "./task-runtime-options.js";

const genericTaskFailureSummary = "Task failed; see logs for details.";

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
  if (options.piRunner) {
    return await runTaskRuntimeWithPiRunner({ ...options, piRunner: options.piRunner });
  }
  return await withPiRunWorkspace(
    { workspace: options.workspace, env: options.env, storeDir: options.piStoreDir },
    async (piRunner) => await runTaskRuntimeWithPiRunner({ ...options, piRunner }),
  );
}

function logDiffManifest(options: RunTaskRuntimeOptions, diffManifest: DiffManifest): void {
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
}

function runtimeTasks(options: RunTaskRuntimeOptions) {
  return [
    ...(options.selectedTasks ??
      selectRuntimeTasks({
        plan: options.plan,
        event: options.event,
        taskName: options.taskName,
      })),
  ];
}

/**
 * Loads prior review state and records the outcomes observed on the host since it was written
 * (Pipr resolutions and verifier replies from reply runs, human thread resolutions).
 */
async function loadPriorReview(
  options: RunTaskRuntimeOptions,
  selectedTasks: string[],
  run: PiprRunContext,
) {
  const loaded = options.priorReviewState
    ? undefined
    : await runLoggedPhase(options.log, "load prior review state", async () =>
        options.loadPriorReviewState?.(),
      );
  if (loaded?.events.length) {
    options.findingLedger?.record(findingLedgerContext(options, run), loaded.events);
  }
  const loadedPriorReviewState = options.priorReviewState ?? loaded?.state;
  const priorMainComment =
    options.priorMainComment ??
    (await runLoggedPhase(options.log, "load prior main comment", async () =>
      options.loadPriorMainComment?.(),
    ));
  return {
    priorReviewState: priorReviewStateForSelectedTasks(loadedPriorReviewState, selectedTasks),
    priorMainComment,
  };
}

function structuralContext(options: RunTaskRuntimeOptions, diffManifest: DiffManifest) {
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
  return { structuralAnalysis, structuralManifest };
}

function diffContextCoverageLogFields(stats: ReturnType<typeof reviewStatsForRuns>) {
  const coverage = stats?.diffContextCoverage;
  return coverage
    ? {
        contextFilesTotal: coverage.files.total,
        contextFilesCovered: coverage.files.covered,
        contextRangesTotal: coverage.ranges.total,
        contextRangesCovered: coverage.ranges.covered,
      }
    : {};
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function runTaskRuntimeWithPiRunner(
  options: RunTaskRuntimeOptions & { piRunner: PiRunner },
): Promise<ReviewRuntimeResult> {
  const runtimeStarted = Date.now();
  const config = parsePiprConfig(options.config);
  registerProviderSecrets(config.providers, options.env, options);
  const provider = taskRuntimeProvider(options, config);
  await options.progress?.transition("building-diff");
  const diffManifest = parseDiffManifest(
    (options.diffManifestBuilder ?? buildDiffManifest)({
      cwd: options.workspace,
      baseSha: options.event.change.base.sha,
      headSha: options.event.change.head.sha,
      env: options.env,
    }),
  );
  logDiffManifest(options, diffManifest);
  await recordArtifactSafely(options, {
    kind: "diff-manifest",
    name: "diff-manifest.json",
    mediaType: "application/json",
    content: JSON.stringify(diffManifest, null, 2),
    sensitive: true,
  });
  const tasks = runtimeTasks(options);
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
  const { priorReviewState, priorMainComment } = await loadPriorReview(options, selectedTasks, run);
  const piRuns: PiRunStats[] = [];
  const agentRunBudget = createAgentRunBudget(config.limits?.maxAgentRuns);
  const { structuralAnalysis, structuralManifest } = structuralContext(options, diffManifest);
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
    throw asError(failedTask.error);
  }
  const output = mergeTaskOutputs(taskResults);
  options.log?.info("task runtime collected", {
    findings: output.findings.length,
    providerModels: output.providerModels,
    repairAttempted: output.repairAttempted,
  });
  const commandDurationMs = Date.now() - runtimeStarted;
  const commandResponse = commandResponseRuntimeResult({
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
    findingOutcomes: (dispositions) =>
      deriveReviewFindingOutcomes({
        valid: redactedPublication.validated.validFindings.map((finding, index) => ({
          finding,
          attribution: findingAttribution(output, validated.validFindings[index] ?? finding),
        })),
        dispositions,
        dropped: redactedPublication.validated.droppedFindings.map((dropped, index) => ({
          finding: dropped.finding,
          code: dropped.code,
          attribution: findingAttribution(
            output,
            validated.droppedFindings[index]?.finding ?? dropped.finding,
          ),
        })),
        priorReviewState,
        verdicts: verifier.verdicts,
      }),
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
  options.findingLedger?.record(findingLedgerContext(options, run), publishing.findingOutcomes);
  publishTaskChecks(options.checkSink, redactedPublication.taskChecks);
  options.log?.info("review validated", {
    validFindings: validated.validFindings.length,
    droppedFindings: validated.droppedFindings.length,
    inlineDrafts: publishing.inlineCommentDrafts.length,
    threadActions: verifier.threadActions.length,
    ...diffContextCoverageLogFields(stats),
  });
  await recordDiffContextCoverageArtifact(options, piRuns);
  await Promise.all([
    recordArtifactSafely(options, {
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
    recordArtifactSafely(options, {
      kind: "validation",
      name: "validation.json",
      mediaType: "application/json",
      content: JSON.stringify(redactedPublication.validated, null, 2),
      sensitive: true,
    }),
    recordArtifactSafely(options, {
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

async function recordDiffContextCoverageArtifact(
  options: Pick<RunTaskRuntimeOptions, "runObserver" | "log">,
  piRuns: readonly PiRunStats[],
): Promise<void> {
  const content = diffContextCoverageArtifact(
    piRuns.map((piRun) => piRun.diffContextCoverage).filter((coverage) => coverage !== undefined),
  );
  if (!content) return;
  await recordArtifactSafely(options, {
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

async function executeSelectedTasks(options: {
  tasks: readonly RuntimeTask[];
  runtimeOptions: RunTaskRuntimeOptions;
  context: Omit<Parameters<typeof createTaskContext>[0], "output" | "taskName" | "taskOrder">;
}): Promise<TaskRunResult[]> {
  return Promise.all(
    options.tasks.map(async (task, taskOrder): Promise<TaskRunResult> => {
      const output = createOutputState();
      const started = Date.now();
      const taskId = String(taskOrder);
      options.runtimeOptions.log?.info("task start", { task: task.name, order: taskOrder });
      const observedTask = options.runtimeOptions.runObserver?.beginTask?.({
        name: task.name,
        order: taskOrder,
      });
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
        observedTask?.finish({
          status: "ok",
          findings: output.findings.length,
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
        observedTask?.finish({ status: "error" });
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
      verdicts: [],
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
    piProviderModule: options.options.piProviderModule,
    piAuthFile: options.options.piAuthFile,
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

function commandResponseRuntimeResult(options: {
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
  const redacted = redactCommandPublication({
    body: commandResponse.value,
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
