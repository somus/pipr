import type { RuntimeTask } from "@usepipr/sdk/internal";
import type { CodeHostAdapter } from "../hosts/types.js";
import { recordArtifactSafely } from "../observability/capture-sinks.js";
import type { RunObserver } from "../observability/types.js";
import type { ThreadAction } from "../publication/types.js";
import {
  type FindingLedger,
  type FindingLedgerContext,
  type FindingOutcomeEmission,
  findingLedgerContext,
  findingOutcomeAnchors,
} from "../review/finding-ledger.js";
import { ReviewProgressSupersededError } from "../review/progress.js";
import { publicationPlanForHostCapabilities } from "../review/publication-plan.js";
import { PublicationError } from "../review/publication-result.js";
import type { RuntimeCommandInvocation } from "../review/run-identity.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";
import type { HostRunServices } from "./composition.js";
import { changeRequestPiStoreDir } from "./pi-store.js";
import type { ReviewProgressReporter } from "./review-progress.js";
import {
  finalizeRuntimeChecks,
  genericCheckFailureSummary,
  startRuntimeChecks,
} from "./runtime-checks.js";
import type { TrustedReviewAndPublishResult, TrustedRuntimeProject } from "./types.js";

export async function runTrustedReviewAndPublish(options: {
  services: HostRunServices;
  trustedRuntime: TrustedRuntimeProject;
  event: ChangeRequestEventContext;
  taskName?: string;
  taskInput?: unknown;
  selectedTasks: RuntimeTask[];
  commandInvocation?: RuntimeCommandInvocation;
  workflowUrl?: string;
  progress?: ReviewProgressReporter;
}): Promise<TrustedReviewAndPublishResult> {
  const { services } = options;
  const checks = await startRuntimeChecks({
    adapter: services.adapter,
    event: options.event,
    plan: options.trustedRuntime.plan,
    taskName: options.taskName,
    selectedTasks: options.selectedTasks,
    log: services.log,
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
  const { services } = options;
  return await runTaskRuntime({
    workspace: services.rootDir,
    config: options.trustedRuntime.settings.config,
    event: options.event,
    env: services.env,
    plan: options.trustedRuntime.plan,
    versionCompatibility: options.trustedRuntime.versionCompatibility,
    taskName: options.taskName,
    taskInput: options.taskInput,
    selectedTasks: options.selectedTasks,
    commandInvocation: options.commandInvocation,
    trustedConfigSha: options.trustedRuntime.trustedConfigSha,
    trustedConfigHash: options.trustedRuntime.trustedConfigHash,
    piProviderModule: services.piProviderModule,
    piStoreDir: changeRequestPiStoreDir(services.piStoreRoot, options.event),
    piRunner: services.piRunner,
    log: services.log,
    checkSink,
    secretRedactor: services.secretRedactor,
    runObserver: services.runObserver,
    findingLedger: services.findingLedger,
    workflowUrl: options.workflowUrl,
    progress: options.progress,
    loadPriorReviewState: () =>
      services.adapter.comments?.loadPriorReviewState?.({ change: options.event }) ??
      Promise.resolve(undefined),
    loadPriorMainComment: () =>
      services.adapter.comments?.loadPriorMainComment?.({ change: options.event }) ??
      Promise.resolve(undefined),
    loadInlineThreadContexts: () =>
      services.adapter.comments?.loadInlineThreadContexts?.({ change: options.event }) ??
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
  const { services } = options;
  const publish = services.adapter.publication?.publish;
  if (!publish) throw new Error("review publication is not available for this code host");
  const ledgerContext = findingLedgerContext(
    { event: options.event, trustedConfigHash: options.trustedRuntime.trustedConfigHash },
    review.run,
  );
  const recordPublished = (findingIds: readonly string[]) =>
    services.findingLedger.recordPublished(ledgerContext, findingIds);
  try {
    return await services.log.group("publish review", async () => {
      await options.progress?.transition("publishing-review");
      const plan = publicationPlanForHostCapabilities(
        review.publicationPlan,
        services.adapter.capabilities,
      );
      recordUnsupportedInlineFindings(services.findingLedger, ledgerContext, review, plan);
      services.log.info("publication plan", {
        inlineItems: plan.inlineItems.length,
        threadActions: plan.threadActions.length,
      });
      const result = await publish({
        change: options.event,
        plan,
        progressLease: options.progress?.lease,
        onInlinePosted: (findingId) => recordPublished([findingId]),
        onThreadActionApplied: threadActionOutcomeRecorder(
          services.findingLedger,
          ledgerContext,
          review.threadActionOutcomes,
        ),
      });
      recordPublished(result.postedFindingIds);
      logPublicationResult(services.log, result);
      await recordArtifactSafely(services, {
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
    recordPublished(publicationError.result?.postedFindingIds ?? []);
    await recordPublicationError(services, publicationError, error);
    throw publicationError;
  }
}

/** Records inline findings the host cannot post, such as multi-line comments, as dropped. */
function recordUnsupportedInlineFindings(
  ledger: FindingLedger,
  context: FindingLedgerContext,
  review: Extract<RuntimeReview, { kind: "review" }>,
  plan: Extract<RuntimeReview, { kind: "review" }>["publicationPlan"],
): void {
  const supported = new Set(plan.inlineItems.map((item) => item.findingId));
  ledger.record(
    context,
    review.publicationPlan.inlineItems
      .filter((item) => !supported.has(item.findingId))
      .map((item) => ({
        kind: "dropped" as const,
        findingId: item.findingId,
        reasonCode: "inline-unsupported" as const,
      })),
  );
}

/**
 * Records verifier outcomes once the thread action that leaves their marker is on the host, so
 * the ledger never holds an outcome whose marker a failed write left unposted.
 */
export function threadActionOutcomeRecorder(
  ledger: FindingLedger,
  context: FindingLedgerContext,
  outcomes: readonly FindingOutcomeEmission[],
): (action: ThreadAction) => void {
  return (action) => {
    const anchor =
      action.kind === "resolve"
        ? findingOutcomeAnchors.piprResolution(action.findingHeadSha)
        : findingOutcomeAnchors.verifierResponse(action.responseKey);
    ledger.record(
      context,
      outcomes.filter(
        (outcome) => outcome.findingId === action.findingId && outcome.anchor === anchor,
      ),
    );
  };
}

function logPublicationResult(
  log: RuntimeLog,
  result: Awaited<ReturnType<NonNullable<NonNullable<CodeHostAdapter["publication"]>["publish"]>>>,
): void {
  log.notice("publication result", {
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
  services: HostRunServices,
  publicationError: PublicationError,
  cause: unknown,
): Promise<void> {
  await recordArtifactSafely(services, {
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
    options.services.log.warning("check finalization after failure failed", {
      error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
    });
  });
}
