import { formatReviewDuration, renderReviewStatsTable } from "./comment.js";
import {
  mainCommentFooterHiddenMarker,
  mainCommentHeaderHiddenMarker,
  mainCommentTitle,
  mainCommentTitles,
  piprProgressImageUrl,
  reviewProgressEndMarker,
} from "./comment-branding.js";
import type { ReviewStats } from "./review-stats.js";

const reviewProgressStages = [
  "preparing-workspace",
  "building-diff",
  "running-review-tasks",
  "validating-review",
  "publishing-review",
] as const;

export type ReviewProgressStage = (typeof reviewProgressStages)[number];

export type ReviewWorkState = "running" | "completed" | "failed";

export type ReviewWorkSnapshot = {
  tasks: Array<{
    id: string;
    name: string;
    state: ReviewWorkState;
    reviewers: Array<{
      id: string;
      name: string;
      state: ReviewWorkState;
      shard?: {
        current: number;
        total: number;
      };
    }>;
  }>;
  completedRuns: number;
  activeReviewers: number;
};

export type ReviewWorkEvent =
  | {
      type: "task-started";
      taskId: string;
      taskName: string;
      taskOrder: number;
    }
  | {
      type: "task-finished";
      taskId: string;
      taskName: string;
      outcome: "completed" | "failed";
    }
  | {
      type: "reviewer-started";
      taskId: string;
      reviewerId: string;
      reviewerName: string;
      reviewerOrder: number;
      totalRuns: number;
    }
  | {
      type: "review-run-started";
      taskId: string;
      reviewerId: string;
      reviewerName: string;
      run: number;
      totalRuns: number;
    }
  | {
      type: "review-run-finished";
      taskId: string;
      reviewerId: string;
      reviewerName: string;
      run: number;
      totalRuns: number;
      outcome: "completed" | "failed";
    }
  | {
      type: "reviewer-finished";
      taskId: string;
      reviewerId: string;
      reviewerName: string;
      outcome: "completed" | "failed";
    };

export type ReviewProgressSink = {
  transition(stage: ReviewProgressStage): Promise<void>;
  work(event: ReviewWorkEvent): void;
};

export class ReviewProgressSupersededError extends Error {
  constructor() {
    super("Review progress was superseded by a newer run");
    this.name = "ReviewProgressSupersededError";
  }
}

const progressLabels: Record<ReviewProgressStage, string> = {
  "preparing-workspace": "Preparing workspace",
  "building-diff": "Building diff",
  "running-review-tasks": "Running review tasks",
  "validating-review": "Validating review",
  "publishing-review": "Publishing review",
};

const progressStartPattern =
  /^<!-- pipr:progress:start token=([A-Za-z0-9-]+) head=([^\s]+) stage=([a-z-]+) state=(running|failed) -->$/;

export type ReviewProgressLease = {
  token: string;
  mainCommentId: string;
  mainCommentAction: "created" | "updated";
  reviewedHeadSha: string;
};

export type RenderReviewProgressOptions = {
  body?: string;
  changeNumber: number;
  token: string;
  reviewedHeadSha: string;
  stage: ReviewProgressStage;
  showHeader: boolean;
  showFooter: boolean;
  firstRun?: boolean;
  work?: ReviewWorkSnapshot;
};

export function renderRunningReviewProgress(options: RenderReviewProgressOptions): string {
  const body = baseMainComment(options);
  const stageIndex = reviewProgressStages.indexOf(options.stage);
  const rows = reviewProgressStages.flatMap((stage, index) => {
    const label = escapeHtml(progressLabels[stage]);
    if (index < stageIndex) return [`✅ ${label}`];
    if (index !== stageIndex) return [`○ ${label}`];
    return [
      `⏳ <strong>Running: ${label}</strong>`,
      ...(stage === "running-review-tasks" && options.work ? renderReviewWork(options.work) : []),
    ];
  });
  const block = [
    progressStartMarker(options, "running"),
    "## ⏳ Progress",
    "",
    "<table><tr>",
    `<td><img src="${piprProgressImageUrl}" width="48" height="48" alt=""></td>`,
    `<td>${rows.join("<br>")}</td>`,
    "</tr></table>",
    ...progressFooter(options, "running"),
    ...progressSeparator(options),
    reviewProgressEndMarker,
  ];
  return insertProgressBlock(body, block);
}

export function renderFailedReviewProgress(
  options: RenderReviewProgressOptions & {
    durationMs: number;
    reason: string;
    workflowUrl?: string;
    stats?: ReviewStats;
    showStats: boolean;
  },
): string {
  const body = baseMainComment(options);
  const failedWork = failedWorkLine(options.work);
  const details = [
    progressStartMarker(options, "failed"),
    "## ❌ Review failed",
    "",
    "<details open>",
    `<summary>Review failed after ${formatReviewDuration(options.durationMs)}</summary>`,
    "",
    `**Failed stage:** ${progressLabels[options.stage]}  `,
    ...(failedWork ? [`${failedWork}  `] : []),
    `**Reason:** ${sanitizeProgressFailureReason(options.reason)}`,
    ...(options.workflowUrl ? ["", `**Workflow:** [View workflow](<${options.workflowUrl}>)`] : []),
    ...(options.showStats && options.stats
      ? [
          "",
          ...renderReviewStatsTable(
            {
              ...options.stats,
              usageStatus: options.stats.usageStatus === "unavailable" ? "unavailable" : "partial",
            },
            options.workflowUrl ? [options.workflowUrl] : undefined,
          ),
        ]
      : []),
    "",
    "</details>",
    ...progressFooter(options, "failed"),
    ...progressSeparator(options),
    reviewProgressEndMarker,
  ];
  return insertProgressBlock(body, details);
}

export function reviewProgressRange(lines: string[]): { start: number; end: number } | undefined {
  const start = lines.findIndex((line) => progressStartPattern.test(line));
  if (start < 0) return undefined;
  const endOffset = lines.slice(start + 1).indexOf(reviewProgressEndMarker);
  return endOffset < 0 ? undefined : { start, end: start + 1 + endOffset };
}

export function extractReviewProgressToken(body: string | undefined): string | undefined {
  if (!body) return undefined;
  const range = reviewProgressRange(body.split("\n"));
  if (!range) return undefined;
  return body.split("\n")[range.start]?.match(progressStartPattern)?.[1];
}

export function stripReviewProgress(body: string): string {
  const lines = body.split("\n");
  const range = reviewProgressRange(lines);
  if (!range) return body;
  lines.splice(range.start, range.end - range.start + 1);
  if (lines[range.start] === "") {
    lines.splice(range.start, 1);
  }
  return lines.join("\n").trimEnd();
}

function sanitizeProgressFailureReason(reason: string): string {
  const firstLine = reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Review failed; see runner logs.";
  const normalized = firstLine.replace(/\s+/g, " ").slice(0, 160);
  return normalized
    .replaceAll("&", "&amp;")
    .replaceAll("\\", "\\\\")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;");
}

function baseMainComment(options: RenderReviewProgressOptions): string {
  if (options.body) {
    return stripReviewProgress(options.body);
  }
  return [
    `<!-- pipr:main-comment change=${options.changeNumber} version=1 -->`,
    "",
    ...(!options.showHeader ? [mainCommentHeaderHiddenMarker, ""] : []),
    ...(options.showHeader ? [mainCommentTitle, ""] : []),
  ].join("\n");
}

function insertProgressBlock(body: string, block: string[]): string {
  const lines = body.split("\n");
  const markerIndex = lines.findIndex((line) => line.startsWith("<!-- pipr:main-comment "));
  let insertionIndex = markerIndex >= 0 ? markerIndex + 1 : 0;
  const firstContentOffset = lines.slice(insertionIndex).findIndex((line) => line !== "");
  const firstContentIndex =
    firstContentOffset >= 0 ? insertionIndex + firstContentOffset : insertionIndex;
  if (
    lines[firstContentIndex] === mainCommentHeaderHiddenMarker ||
    mainCommentTitles.has(lines[firstContentIndex] ?? "")
  ) {
    insertionIndex = firstContentIndex + 1;
  }
  lines.splice(insertionIndex, 0, ...block, "");
  return lines.join("\n").trimEnd();
}

function progressStartMarker(
  options: Pick<RenderReviewProgressOptions, "token" | "reviewedHeadSha" | "stage">,
  state: "running" | "failed",
): string {
  return `<!-- pipr:progress:start token=${options.token} head=${options.reviewedHeadSha} stage=${options.stage} state=${state} -->`;
}

function progressFooter(
  options: Pick<RenderReviewProgressOptions, "firstRun" | "showFooter" | "reviewedHeadSha">,
  state: "running" | "failed",
): string[] {
  if (!options.firstRun) return [];
  if (!options.showFooter) return ["", mainCommentFooterHiddenMarker];
  const verb = state === "running" ? "is reviewing" : "stopped while reviewing";
  return ["", `<sub>Pipr ${verb} commit \`${options.reviewedHeadSha.slice(0, 7)}\`.</sub>`];
}

function progressSeparator(options: Pick<RenderReviewProgressOptions, "firstRun">): string[] {
  return options.firstRun ? [] : ["", "---"];
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

type ReviewWorkTask = ReviewWorkSnapshot["tasks"][number];
type ReviewWorkReviewer = ReviewWorkTask["reviewers"][number];

function renderReviewWork(work: ReviewWorkSnapshot): string[] {
  const { tasks, hiddenReviewerCount } = boundedReviewWork(work.tasks);
  const rows = tasks.flatMap(renderReviewWorkTask);
  if (hiddenReviewerCount > 0) {
    rows.push(
      `<small>+${hiddenReviewerCount} more ${plural(hiddenReviewerCount, "reviewer")} active</small>`,
    );
  }
  if (work.completedRuns > 0 || work.activeReviewers > 0) {
    rows.push(
      `<small><strong>Completed:</strong> ${work.completedRuns} ${plural(work.completedRuns, "review run")} · ${work.activeReviewers} ${plural(work.activeReviewers, "reviewer")} active</small>`,
    );
  }
  return rows;
}

function boundedReviewWork(tasks: ReviewWorkTask[]): {
  tasks: Array<{ task: ReviewWorkTask; reviewers: ReviewWorkReviewer[] }>;
  hiddenReviewerCount: number;
} {
  const bounded: Array<{ task: ReviewWorkTask; reviewers: ReviewWorkReviewer[] }> = [];
  let visibleReviewerCount = 0;
  for (const task of tasks) {
    const reviewers = task.reviewers.slice(0, Math.max(0, 3 - visibleReviewerCount));
    if (reviewers.length > 0 || task.reviewers.length === 0) bounded.push({ task, reviewers });
    visibleReviewerCount += reviewers.length;
  }
  const reviewerCount = tasks.reduce((count, task) => count + task.reviewers.length, 0);
  return { tasks: bounded, hiddenReviewerCount: reviewerCount - visibleReviewerCount };
}

function renderReviewWorkTask(options: {
  task: ReviewWorkTask;
  reviewers: ReviewWorkReviewer[];
}): string[] {
  return [
    `<small><strong>Task:</strong> <code>${escapeHtml(options.task.name)}</code></small>`,
    ...options.reviewers.map(renderReviewWorkReviewer),
  ];
}

function renderReviewWorkReviewer(reviewer: ReviewWorkReviewer): string {
  const shard = reviewer.shard
    ? ` · shard ${reviewer.shard.current} of ${reviewer.shard.total}`
    : "";
  return `<small>&nbsp;&nbsp;↳ <strong>Reviewer:</strong> <code>${escapeHtml(reviewer.name)}</code>${shard}</small>`;
}

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

function failedWorkLine(work: ReviewWorkSnapshot | undefined): string | undefined {
  const task = work?.tasks.find((candidate) => candidate.state === "failed");
  if (!task) return undefined;
  const reviewer = task.reviewers.find((candidate) => candidate.state === "failed");
  const reviewerText = reviewer ? ` · Reviewer <code>${escapeHtml(reviewer.name)}</code>` : "";
  const shardText = reviewer?.shard
    ? ` · shard ${reviewer.shard.current} of ${reviewer.shard.total}`
    : "";
  return `**Failed work:** Task <code>${escapeHtml(task.name)}</code>${reviewerText}${shardText}`;
}
