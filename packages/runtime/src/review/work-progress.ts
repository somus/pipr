import type { ReviewWorkEvent, ReviewWorkSnapshot, ReviewWorkState } from "./progress.js";

type TrackedReviewer = {
  id: string;
  name: string;
  order: number;
  state: ReviewWorkState;
  currentRun?: number;
  totalRuns: number;
};

type TrackedTask = {
  id: string;
  name: string;
  order: number;
  state: ReviewWorkState;
  reviewers: Map<string, TrackedReviewer>;
};

type TrackerState = {
  tasks: Map<string, TrackedTask>;
  finishedRuns: Set<string>;
  completedRuns: number;
};

export type ReviewWorkTracker = {
  record(event: ReviewWorkEvent): ReviewWorkSnapshot;
  snapshot(): ReviewWorkSnapshot;
};

export function createReviewWorkTracker(): ReviewWorkTracker {
  const state: TrackerState = {
    tasks: new Map(),
    finishedRuns: new Set(),
    completedRuns: 0,
  };
  return {
    record(event) {
      applyReviewWorkEvent(state, event);
      return reviewWorkSnapshot(state);
    },
    snapshot() {
      return reviewWorkSnapshot(state);
    },
  };
}

function applyReviewWorkEvent(state: TrackerState, event: ReviewWorkEvent): void {
  switch (event.type) {
    case "task-started":
      startTask(state, event);
      break;
    case "task-finished":
      finishTask(state, event);
      break;
    case "reviewer-started":
      startReviewer(state, event);
      break;
    case "review-run-started":
      updateReviewerRun(state, event);
      break;
    case "review-run-finished":
      finishReviewRun(state, event);
      break;
    case "reviewer-finished":
      finishReviewer(state, event);
      break;
  }
}

function startTask(
  state: TrackerState,
  event: Extract<ReviewWorkEvent, { type: "task-started" }>,
): void {
  state.tasks.set(event.taskId, {
    id: event.taskId,
    name: event.taskName,
    order: event.taskOrder,
    state: "running",
    reviewers: new Map(),
  });
}

function finishTask(
  state: TrackerState,
  event: Extract<ReviewWorkEvent, { type: "task-finished" }>,
): void {
  const task = state.tasks.get(event.taskId);
  if (task) task.state = event.outcome;
}

function startReviewer(
  state: TrackerState,
  event: Extract<ReviewWorkEvent, { type: "reviewer-started" }>,
): void {
  state.tasks.get(event.taskId)?.reviewers.set(event.reviewerId, {
    id: event.reviewerId,
    name: event.reviewerName,
    order: event.reviewerOrder,
    state: "running",
    totalRuns: event.totalRuns,
  });
}

function updateReviewerRun(
  state: TrackerState,
  event: Extract<ReviewWorkEvent, { type: "review-run-started" | "review-run-finished" }>,
): void {
  const reviewer = state.tasks.get(event.taskId)?.reviewers.get(event.reviewerId);
  if (!reviewer) return;
  reviewer.currentRun = event.run;
  reviewer.totalRuns = event.totalRuns;
}

function finishReviewRun(
  state: TrackerState,
  event: Extract<ReviewWorkEvent, { type: "review-run-finished" }>,
): void {
  updateReviewerRun(state, event);
  const runId = `${event.reviewerId}:${event.run}`;
  if (event.outcome !== "completed" || state.finishedRuns.has(runId)) return;
  state.finishedRuns.add(runId);
  state.completedRuns += 1;
}

function finishReviewer(
  state: TrackerState,
  event: Extract<ReviewWorkEvent, { type: "reviewer-finished" }>,
): void {
  const reviewer = state.tasks.get(event.taskId)?.reviewers.get(event.reviewerId);
  if (reviewer) reviewer.state = event.outcome;
}

function reviewWorkSnapshot(state: TrackerState): ReviewWorkSnapshot {
  const visibleTasks = [...state.tasks.values()]
    .filter((task) => task.state !== "completed")
    .sort((left, right) => left.order - right.order)
    .map((task) => ({
      id: task.id,
      name: task.name,
      state: task.state,
      reviewers: [...task.reviewers.values()]
        .filter((reviewer) => reviewer.state !== "completed")
        .sort((left, right) => left.order - right.order)
        .map((reviewer) => ({
          id: reviewer.id,
          name: reviewer.name,
          state: reviewer.state,
          ...(reviewer.totalRuns > 1 && reviewer.currentRun
            ? {
                shard: {
                  current: reviewer.currentRun,
                  total: reviewer.totalRuns,
                },
              }
            : {}),
        })),
    }));
  return {
    tasks: visibleTasks,
    completedRuns: state.completedRuns,
    activeReviewers: visibleTasks.reduce(
      (count, task) =>
        count + task.reviewers.filter((reviewer) => reviewer.state === "running").length,
      0,
    ),
  };
}
