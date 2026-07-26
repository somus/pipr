import type { CodeHostAdapter } from "../hosts/types.js";
import {
  type ReviewProgressLease,
  type ReviewProgressSink,
  type ReviewProgressStage,
  ReviewProgressSupersededError,
  renderFailedReviewProgress,
  renderRunningReviewProgress,
} from "../review/progress.js";
import type { ReviewStats } from "../review/review-stats.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { SecretRedactor } from "../shared/secret-redaction.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";

export type ReviewProgressReporter = ReviewProgressSink & {
  readonly lease: ReviewProgressLease;
  readonly activeStage: ReviewProgressStage;
  recordStats(stats: ReviewStats | undefined): void;
  fail(error: unknown): Promise<void>;
};

export async function startReviewProgress(options: {
  adapter: CodeHostAdapter;
  event: ChangeRequestEventContext;
  config: PiprConfig;
  workflowUrl?: string;
  log: RuntimeLog;
  secretRedactor?: SecretRedactor;
}): Promise<ReviewProgressReporter | undefined> {
  if (!options.config.publication.showProgress) return undefined;
  const publish = options.adapter.publication?.publishReviewProgress;
  const load = options.adapter.comments?.loadPriorMainComment;
  if (!publish || !load) {
    throw new Error("review progress publication is not available for this code host");
  }
  const token = crypto.randomUUID();
  const reviewedHeadSha = options.event.change.head.sha;
  const startedAt = Date.now();
  let activeStage: ReviewProgressStage = "preparing-workspace";
  let stats: ReviewStats | undefined;
  const currentBody = await load({ change: options.event });
  const initial = await publish({
    change: options.event,
    reviewedHeadSha,
    body: renderRunningReviewProgress({
      body: currentBody,
      changeNumber: options.event.change.number,
      token,
      reviewedHeadSha,
      stage: activeStage,
      showHeader: options.config.publication.showHeader,
      showFooter: options.config.publication.showFooter,
    }),
  });
  if (initial.status === "superseded") throw new ReviewProgressSupersededError();
  const lease: ReviewProgressLease = {
    token,
    mainCommentId: initial.id,
    mainCommentAction: initial.action,
    reviewedHeadSha,
  };

  return {
    lease,
    get activeStage() {
      return activeStage;
    },
    recordStats(next) {
      stats = next;
    },
    async transition(stage) {
      if (stage === activeStage) return;
      const body = await load({ change: options.event });
      const result = await publish({
        change: options.event,
        reviewedHeadSha,
        expectedToken: token,
        body: renderRunningReviewProgress({
          body,
          changeNumber: options.event.change.number,
          token,
          reviewedHeadSha,
          stage,
          showHeader: options.config.publication.showHeader,
          showFooter: options.config.publication.showFooter,
        }),
      });
      if (result.status === "superseded") throw new ReviewProgressSupersededError();
      activeStage = stage;
    },
    async fail(error) {
      if (error instanceof ReviewProgressSupersededError) return;
      const reason = error instanceof Error ? error.message : String(error);
      const redactedReason = options.secretRedactor?.redact(reason).value ?? reason;
      try {
        const body = await load({ change: options.event });
        const result = await publish({
          change: options.event,
          reviewedHeadSha,
          expectedToken: token,
          body: renderFailedReviewProgress({
            body,
            changeNumber: options.event.change.number,
            token,
            reviewedHeadSha,
            stage: activeStage,
            showHeader: options.config.publication.showHeader,
            showFooter: options.config.publication.showFooter,
            showStats: options.config.publication.showStats,
            durationMs: Date.now() - startedAt,
            reason: redactedReason,
            workflowUrl: options.workflowUrl,
            stats,
          }),
        });
        if (result.status === "superseded") return;
      } catch (progressError) {
        const progressReason =
          progressError instanceof Error ? progressError.message : String(progressError);
        options.log.warning("review progress failure publication failed", {
          error: options.secretRedactor?.redact(progressReason).value ?? progressReason,
          originalError: redactedReason,
        });
      }
    },
  };
}
