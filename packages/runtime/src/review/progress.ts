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

export type ReviewProgressSink = {
  transition(stage: ReviewProgressStage): Promise<void>;
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
};

export function renderRunningReviewProgress(options: RenderReviewProgressOptions): string {
  const body = baseMainComment(options);
  const stageIndex = reviewProgressStages.indexOf(options.stage);
  const rows = reviewProgressStages.map((stage, index) => {
    const label = escapeHtml(progressLabels[stage]);
    if (index < stageIndex) return `✓ ${label}`;
    if (index === stageIndex) return `<strong>Running: ${label}</strong>`;
    return `○ ${label}`;
  });
  const block = [
    progressStartMarker(options, "running"),
    "## Progress",
    "",
    "<table><tr>",
    `<td><img src="${piprProgressImageUrl}" width="48" height="48" alt=""></td>`,
    `<td>${rows.join("<br>")}</td>`,
    "</tr></table>",
    ...progressFooter(options, "running"),
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
  const details = [
    progressStartMarker(options, "failed"),
    "<details>",
    `<summary>Review failed after ${formatReviewDuration(options.durationMs)}</summary>`,
    "",
    `**Failed stage:** ${progressLabels[options.stage]}  `,
    `**Reason:** ${sanitizeProgressFailureReason(options.reason)}`,
    ...(options.workflowUrl ? ["", `**Workflow:** [View workflow](<${options.workflowUrl}>)`] : []),
    ...(options.showStats && options.stats
      ? ["", ...renderReviewStatsTable({ ...options.stats, usageStatus: "partial" })]
      : []),
    "",
    "</details>",
    ...progressFooter(options, "failed"),
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

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
