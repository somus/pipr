import type { RuntimeTask } from "@usepipr/sdk/internal";
import type { CodeHostAdapter } from "../hosts/types.js";
import { publicationPlanForHostCapabilities } from "../review/comment.js";
import { ReviewProgressSupersededError } from "../review/progress.js";
import { PublicationError } from "../review/publication-result.js";
import { type RuntimeCommandInvocation, runTaskRuntime } from "../review/task/task-runtime.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";
import type { ReviewProgressReporter } from "./review-progress.js";
import {
  finalizeRuntimeChecks,
  genericCheckFailureSummary,
  startRuntimeChecks,
} from "./runtime-checks.js";
import type {
  HostRunCommandDependencyOptions,
  TrustedReviewAndPublishResult,
  TrustedRuntimeProject,
} from "./types.js";

export async function runTrustedReviewAndPublish(options: {
  options: HostRunCommandDependencyOptions;
  adapter: CodeHostAdapter;
  trustedRuntime: TrustedRuntimeProject;
  event: ChangeRequestEventContext;
  taskName?: string;
  taskInput?: unknown;
  selectedTasks: RuntimeTask[];
  commandInvocation?: RuntimeCommandInvocation;
  workflowUrl?: string;
  progress?: ReviewProgressReporter;
  log: RuntimeLog;
}): Promise<TrustedReviewAndPublishResult> {
  const checks = await startRuntimeChecks({
    adapter: options.adapter,
    event: options.event,
    plan: options.trustedRuntime.plan,
    taskName: options.taskName,
    selectedTasks: options.selectedTasks,
    log: options.log,
  });
  try {
    if (checks?.startupError) throw checks.startupError;
    const review = await executeTaskRuntime(options, checks?.sink);
    const earlyResult = await earlyReviewResult(review, checks);
    if (earlyResult) return earlyResult;
    const completedReview = requirePublishableReview(review);
    await finalizeRuntimeChecks(checks, {});
    const publication = await publishCompletedReview(options, completedReview);
    return { kind: "completed", review: completedReview, publication };
  } catch (error) {
    let finalError = error;
    if ((await options.progress?.fail(error)) === "superseded") {
      finalError = new ReviewProgressSupersededError();
    }
    await finalizeFailedChecks(options, checks, finalError);
    throw finalError;
  }
}

type ReviewPublishingOptions = Parameters<typeof runTrustedReviewAndPublish>[0];
type RuntimeReview = Awaited<ReturnType<typeof runTaskRuntime>>;
type RuntimeChecks = Awaited<ReturnType<typeof startRuntimeChecks>>;

async function executeTaskRuntime(
  options: ReviewPublishingOptions,
  checkSink: NonNullable<RuntimeChecks>["sink"] | undefined,
): Promise<RuntimeReview> {
  return await runTaskRuntime({
    workspace: options.options.rootDir,
    config: options.trustedRuntime.settings.config,
    event: options.event,
    env: options.options.env,
    plan: options.trustedRuntime.plan,
    versionCompatibility: options.trustedRuntime.versionCompatibility,
    taskName: options.taskName,
    taskInput: options.taskInput,
    commandInvocation: options.commandInvocation,
    trustedConfigSha: options.trustedRuntime.trustedConfigSha,
    trustedConfigHash: options.trustedRuntime.trustedConfigHash,
    piExecutable: options.options.piExecutable,
    log: options.log,
    checkSink,
    secretRedactor: options.options.secretRedactor,
    runObserver: options.options.runObserver,
    workflowUrl: options.workflowUrl,
    progress: options.progress,
    loadPriorReviewState: () =>
      options.adapter.comments?.loadPriorReviewState?.({ change: options.event }) ??
      Promise.resolve(undefined),
    loadPriorMainComment: () =>
      options.adapter.comments?.loadPriorMainComment?.({ change: options.event }) ??
      Promise.resolve(undefined),
    loadInlineThreadContexts: () =>
      options.adapter.comments?.loadInlineThreadContexts?.({ change: options.event }) ??
      Promise.resolve([]),
  });
}

function requirePublishableReview(
  review: RuntimeReview,
): Extract<RuntimeReview, { kind: "review" }> {
  if (review.kind !== "review") throw new Error(`Unexpected review result: ${review.kind}`);
  return review;
}

async function earlyReviewResult(
  review: RuntimeReview,
  checks: RuntimeChecks,
): Promise<TrustedReviewAndPublishResult | undefined> {
  if (review.kind === "skipped") {
    await finalizeRuntimeChecks(checks, { skipped: true });
    return { kind: "skipped", reason: review.skipReason ?? "review skipped" };
  }
  if (review.kind !== "command-response") return undefined;
  if (!review.commandResponse)
    throw new Error("command response result did not include a response body");
  await finalizeRuntimeChecks(checks, {});
  return {
    kind: "command-response",
    run: review.run,
    response: {
      commandName: review.commandResponse.commandName,
      body: review.commandResponse.body,
    },
  };
}

async function publishCompletedReview(
  options: ReviewPublishingOptions,
  review: Extract<RuntimeReview, { kind: "review" }>,
) {
  const publish = options.adapter.publication?.publish;
  if (!publish) throw new Error("review publication is not available for this code host");
  try {
    return await options.log.group("publish review", async () => {
      await options.progress?.transition("publishing-review");
      const plan = publicationPlanForHostCapabilities(
        review.publicationPlan,
        options.adapter.capabilities,
      );
      options.log.info("publication plan", {
        inlineItems: plan.inlineItems.length,
        threadActions: plan.threadActions.length,
      });
      const result = await publish({
        change: options.event,
        plan,
        progressLease: options.progress?.lease,
      });
      logPublicationResult(options, result);
      await recordPublicationArtifact(options, {
        kind: "publication-plan",
        name: "publication-result.json",
        mediaType: "application/json",
        content: JSON.stringify(result, null, 2),
        sensitive: false,
      });
      return result;
    });
  } catch (error) {
    if (error instanceof ReviewProgressSupersededError) throw error;
    const publicationError = asPublicationError(error);
    await recordPublicationError(options, publicationError, error);
    throw publicationError;
  }
}

function logPublicationResult(
  options: ReviewPublishingOptions,
  result: Awaited<ReturnType<NonNullable<NonNullable<CodeHostAdapter["publication"]>["publish"]>>>,
): void {
  options.log.notice("publication result", {
    main: result.mainComment.action,
    inlinePosted: result.inlineComments.posted,
    inlineSkipped: result.inlineComments.skipped,
    inlineFailed: result.inlineComments.failed,
    inlineResolutionErrors: result.metadata.inlineResolutionErrors.length,
  });
}

function asPublicationError(error: unknown): PublicationError {
  return error instanceof PublicationError
    ? error
    : new PublicationError(
        `Review publication failed: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        { cause: error },
      );
}

async function recordPublicationError(
  options: ReviewPublishingOptions,
  publicationError: PublicationError,
  cause: unknown,
): Promise<void> {
  await recordPublicationArtifact(options, {
    kind: "publication-plan",
    name: "publication-error.json",
    mediaType: "application/json",
    content: JSON.stringify(
      {
        message: publicationError.message,
        ...(publicationError.result ? { result: publicationError.result } : {}),
        ...(cause instanceof Error ? { cause: { name: cause.name, message: cause.message } } : {}),
      },
      null,
      2,
    ),
    sensitive: true,
  });
}

async function finalizeFailedChecks(
  options: ReviewPublishingOptions,
  checks: RuntimeChecks,
  error: unknown,
): Promise<void> {
  const superseded = error instanceof ReviewProgressSupersededError;
  await finalizeRuntimeChecks(checks, {
    superseded,
    ...(superseded
      ? {}
      : {
          forceFailureSummary: genericCheckFailureSummary,
          preserveTaskOutcomes: Array.from(checks?.outcomes.values() ?? []).some(
            (result) => result.conclusion === "failure",
          ),
        }),
  }).catch((finalizeError: unknown) => {
    options.log.warning("check finalization after failure failed", {
      error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
    });
  });
}

async function recordPublicationArtifact(
  options: Parameters<typeof runTrustedReviewAndPublish>[0],
  artifact: Parameters<
    NonNullable<NonNullable<HostRunCommandDependencyOptions["runObserver"]>["recordArtifact"]>
  >[0],
): Promise<void> {
  try {
    await options.options.runObserver?.recordArtifact?.(artifact);
  } catch (error) {
    options.log.warning("run capture artifact failed", {
      kind: artifact.kind,
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
}
