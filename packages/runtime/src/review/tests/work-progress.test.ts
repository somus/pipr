import { describe, expect, it } from "bun:test";
import type { ReviewWorkEvent } from "../progress.js";
import { createReviewWorkTracker } from "../work-progress.js";

describe("review work tracker", () => {
  it("orders interleaved tasks and reviewers while advancing shard progress once", () => {
    const tracker = createReviewWorkTracker();
    const record = (event: ReviewWorkEvent) => tracker.record(event);

    record({ type: "task-started", taskId: "task-b", taskName: "Task B", taskOrder: 1 });
    record({ type: "task-started", taskId: "task-a", taskName: "Task A", taskOrder: 0 });
    record({
      type: "reviewer-started",
      taskId: "task-a",
      reviewerId: "reviewer-b",
      reviewerName: "Reviewer B",
      reviewerOrder: 1,
      totalRuns: 4,
    });
    record({
      type: "reviewer-started",
      taskId: "task-a",
      reviewerId: "reviewer-a",
      reviewerName: "Reviewer A",
      reviewerOrder: 0,
      totalRuns: 4,
    });
    record({
      type: "review-run-started",
      taskId: "task-a",
      reviewerId: "reviewer-a",
      reviewerName: "Reviewer A",
      run: 2,
      totalRuns: 4,
    });

    expect(tracker.snapshot()).toEqual({
      tasks: [
        {
          id: "task-a",
          name: "Task A",
          state: "running",
          reviewers: [
            {
              id: "reviewer-a",
              name: "Reviewer A",
              state: "running",
              shard: { current: 2, total: 4 },
            },
            {
              id: "reviewer-b",
              name: "Reviewer B",
              state: "running",
            },
          ],
        },
        {
          id: "task-b",
          name: "Task B",
          state: "running",
          reviewers: [],
        },
      ],
      completedRuns: 0,
      activeReviewers: 2,
    });

    const completedRun = {
      type: "review-run-finished",
      taskId: "task-a",
      reviewerId: "reviewer-a",
      reviewerName: "Reviewer A",
      run: 2,
      totalRuns: 4,
      outcome: "completed",
    } as const;
    record(completedRun);
    record(completedRun);

    expect(tracker.snapshot().completedRuns).toBe(1);
  });

  it("hides completed work while retaining failed task and reviewer context", () => {
    const tracker = createReviewWorkTracker();
    const record = (event: ReviewWorkEvent) => tracker.record(event);

    record({ type: "task-started", taskId: "done", taskName: "Done task", taskOrder: 0 });
    record({
      type: "reviewer-started",
      taskId: "done",
      reviewerId: "done:0",
      reviewerName: "Done reviewer",
      reviewerOrder: 0,
      totalRuns: 1,
    });
    record({
      type: "reviewer-finished",
      taskId: "done",
      reviewerId: "done:0",
      reviewerName: "Done reviewer",
      outcome: "completed",
    });
    record({ type: "task-finished", taskId: "done", taskName: "Done task", outcome: "completed" });

    record({ type: "task-started", taskId: "failed", taskName: "Failed task", taskOrder: 1 });
    record({
      type: "reviewer-started",
      taskId: "failed",
      reviewerId: "failed:0",
      reviewerName: "Failed reviewer",
      reviewerOrder: 0,
      totalRuns: 4,
    });
    record({
      type: "review-run-started",
      taskId: "failed",
      reviewerId: "failed:0",
      reviewerName: "Failed reviewer",
      run: 3,
      totalRuns: 4,
    });
    record({
      type: "reviewer-finished",
      taskId: "failed",
      reviewerId: "failed:0",
      reviewerName: "Failed reviewer",
      outcome: "failed",
    });
    record({
      type: "task-finished",
      taskId: "failed",
      taskName: "Failed task",
      outcome: "failed",
    });

    expect(tracker.snapshot()).toEqual({
      tasks: [
        {
          id: "failed",
          name: "Failed task",
          state: "failed",
          reviewers: [
            {
              id: "failed:0",
              name: "Failed reviewer",
              state: "failed",
              shard: { current: 3, total: 4 },
            },
          ],
        },
      ],
      completedRuns: 0,
      activeReviewers: 0,
    });
  });
});
