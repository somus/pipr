import type { CodeHostAdapter } from "../hosts/types.js";
import {
  type ReviewProgressLease,
  type ReviewProgressSink,
  type ReviewProgressStage,
  ReviewProgressSupersededError,
  type ReviewWorkEvent,
  renderFailedReviewProgress,
  renderRunningReviewProgress,
} from "../review/progress.js";
import type { ReviewStats } from "../review/review-stats.js";
import { createReviewWorkTracker } from "../review/work-progress.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { SecretRedactor } from "../shared/secret-redaction.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";

export type ReviewProgressReporter = ReviewProgressSink & {
  readonly lease: ReviewProgressLease;
  readonly activeStage: ReviewProgressStage;
  recordStats(stats: ReviewStats | undefined): void;
  fail(error: unknown): Promise<"failed" | "superseded">;
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
  if (!publish) {
    options.log.warning("review progress publication is not available for this code host", {
      host: options.adapter.id,
    });
    return undefined;
  }
  const publishProgress = publish;
  const token = crypto.randomUUID();
  const reviewedHeadSha = options.event.change.head.sha;
  const startedAt = Date.now();
  let activeStage: ReviewProgressStage = "preparing-workspace";
  let stats: ReviewStats | undefined;
  let firstRun = false;
  let superseded = false;
  let workDirty = false;
  let workPublication: Promise<void> | undefined;
  let failurePublication: Promise<"failed" | "superseded"> | undefined;
  const workTracker = createReviewWorkTracker();
  let lastPublishedWork = JSON.stringify(workTracker.snapshot());
  const initial = await publishProgress({
    change: options.event,
    reviewedHeadSha,
    renderBody(currentBody) {
      firstRun = currentBody === undefined;
      return renderRunningReviewProgress({
        body: currentBody,
        changeNumber: options.event.change.number,
        token,
        reviewedHeadSha,
        stage: activeStage,
        showHeader: options.config.publication.showHeader,
        showFooter: options.config.publication.showFooter,
        firstRun,
      });
    },
  });
  if (initial.status === "superseded") throw new ReviewProgressSupersededError();
  const lease: ReviewProgressLease = {
    token,
    mainCommentId: initial.id,
    mainCommentAction: initial.action,
    reviewedHeadSha,
  };

  function scheduleWorkPublication(): void {
    if (workPublication || !workDirty || activeStage !== "running-review-tasks" || superseded) {
      return;
    }
    workPublication = publishWorkUpdates().finally(() => {
      workPublication = undefined;
      scheduleWorkPublication();
    });
  }

  async function publishWorkUpdates(): Promise<void> {
    while (workDirty && activeStage === "running-review-tasks" && !superseded) {
      workDirty = false;
      const work = workTracker.snapshot();
      const workKey = JSON.stringify(work);
      if (workKey === lastPublishedWork) continue;
      try {
        const result = await publishProgress({
          change: options.event,
          reviewedHeadSha,
          expectedToken: token,
          renderBody: (body) =>
            renderRunningReviewProgress({
              body,
              changeNumber: options.event.change.number,
              token,
              reviewedHeadSha,
              stage: activeStage,
              showHeader: options.config.publication.showHeader,
              showFooter: options.config.publication.showFooter,
              firstRun,
              work,
            }),
        });
        if (result.status === "superseded") {
          superseded = true;
          return;
        }
        lastPublishedWork = workKey;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        options.log.warning("review work progress publication failed", {
          error: options.secretRedactor?.redact(reason).value ?? reason,
        });
      }
    }
  }

  async function drainWorkPublication(): Promise<void> {
    while (workPublication) {
      await workPublication;
    }
  }

  async function publishFailure(error: unknown): Promise<"failed" | "superseded"> {
    if (error instanceof ReviewProgressSupersededError) return "superseded";
    await drainWorkPublication();
    if (superseded) return "superseded";
    workDirty = false;
    const reason = error instanceof Error ? error.message : String(error);
    const redactedReason = options.secretRedactor?.redact(reason).value ?? reason;
    try {
      const result = await publishProgress({
        change: options.event,
        reviewedHeadSha,
        expectedToken: token,
        renderBody: (body) =>
          renderFailedReviewProgress({
            body,
            changeNumber: options.event.change.number,
            token,
            reviewedHeadSha,
            stage: activeStage,
            showHeader: options.config.publication.showHeader,
            showFooter: options.config.publication.showFooter,
            firstRun,
            showStats: options.config.publication.showStats,
            durationMs: Date.now() - startedAt,
            reason: redactedReason,
            workflowUrl: options.workflowUrl,
            stats,
            work: workTracker.snapshot(),
          }),
      });
      return result.status === "superseded" ? "superseded" : "failed";
    } catch (progressError) {
      const progressReason =
        progressError instanceof Error ? progressError.message : String(progressError);
      options.log.warning("review progress failure publication failed", {
        error: options.secretRedactor?.redact(progressReason).value ?? progressReason,
        originalError: redactedReason,
      });
      return "failed";
    }
  }

  return {
    lease,
    get activeStage() {
      return activeStage;
    },
    recordStats(next) {
      stats = next;
    },
    work(event: ReviewWorkEvent) {
      workTracker.record(event);
      workDirty = true;
      scheduleWorkPublication();
    },
    async transition(stage) {
      if (stage === activeStage) return;
      await drainWorkPublication();
      if (superseded) throw new ReviewProgressSupersededError();
      workDirty = false;
      const result = await publishProgress({
        change: options.event,
        reviewedHeadSha,
        expectedToken: token,
        renderBody: (body) =>
          renderRunningReviewProgress({
            body,
            changeNumber: options.event.change.number,
            token,
            reviewedHeadSha,
            stage,
            showHeader: options.config.publication.showHeader,
            showFooter: options.config.publication.showFooter,
            firstRun,
            work: workTracker.snapshot(),
          }),
      });
      if (result.status === "superseded") throw new ReviewProgressSupersededError();
      activeStage = stage;
    },
    fail(error) {
      failurePublication ??= publishFailure(error);
      return failurePublication;
    },
  };
}
