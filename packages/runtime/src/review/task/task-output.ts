import type {
  CheckHandle,
  CommentValue,
  PathFilter,
  PriorReview,
  ReviewFinding,
} from "@usepipr/sdk";
import { z } from "zod";
import type { ReviewResult } from "../../types.js";
import type { PiRunStats } from "../agent/review-run.js";
import {
  mainCommentAttributionPattern,
  mainCommentFooterHiddenMarker,
  mainCommentHeaderHiddenMarker,
  mainCommentTitles,
  reviewStatsEndMarker,
  reviewStatsHiddenMarker,
  reviewStatsStartMarker,
} from "../comment-branding.js";
import { reviewFindingSchema } from "../contract.js";
import type { PriorReviewState } from "../prior-state.js";
import {
  maxReviewStatsModels,
  type ReviewStats,
  sanitizeReviewStatsModel,
} from "../review-stats.js";

export type RuntimeCheckConclusion = "success" | "failure" | "neutral";

export type RuntimeTaskCheckResult = {
  taskName: string;
  conclusion: RuntimeCheckConclusion;
  summary?: string;
};

export type RuntimeCheckSink = {
  setTaskResult(result: RuntimeTaskCheckResult): void;
};

export type OutputState = {
  comment?: CommentContribution;
  commandResponse?: CommandResponseContribution;
  findings: FindingContribution[];
  findingScopes: WeakMap<readonly ReviewFinding[], PathFilter>;
  providerModels: string[];
  repairAttempted: boolean;
  check?: Omit<RuntimeTaskCheckResult, "taskName">;
};

export type CommentContribution = {
  taskName: string;
  value: CommentValue;
};

export type OutputStateWithComment = OutputState & {
  comment: CommentContribution;
};

export type CommandResponseContribution = {
  taskName: string;
  value: string;
};

type FindingContribution = {
  finding: ReviewFinding;
  paths?: PathFilter;
};

export type TaskRunResult = {
  taskName: string;
  output: OutputState;
  error?: unknown;
};

const agentInlineFindingsOutputSchema = z.custom<{
  inlineFindings: readonly ReviewFinding[];
}>(
  (value) =>
    z
      .looseObject({
        inlineFindings: z.array(reviewFindingSchema),
      })
      .safeParse(value).success,
);

const generatedReviewStatsShape = [
  /^$/,
  /^\| Metric \| Total \|$/,
  /^\| --- \| ---: \|$/,
  /^\| Models \| .+ \|$/,
  /^\| Agent runs \| \d+ \|$/,
  /^\| Elapsed \| .+ \|$/,
  /^\| Input tokens \| (?:Unavailable|[\d,]+(?: \(reported\))?) \|$/,
  /^\| Output tokens \| (?:Unavailable|[\d,]+(?: \(reported\))?) \|$/,
  /^\| Cost \(USD\) \| (?:Unavailable|\$\d+(?:\.\d+)?(?:e[+-]?\d+)?(?: \(reported\))?) \|$/,
  /^$/,
  /^<\/details>$/,
  /^<!-- pipr:stats:end -->$/,
];

export function createOutputState(): OutputState {
  return {
    findings: [],
    findingScopes: new WeakMap(),
    providerModels: [],
    repairAttempted: false,
  };
}

export function mergeTaskOutputs(results: TaskRunResult[]): OutputState {
  const merged = createOutputState();
  for (const { output } of results) {
    mergeCommentContribution(merged, output.comment);
    mergeCommandResponseContribution(merged, output.commandResponse);
    merged.findings.push(...output.findings);
    merged.providerModels.push(...output.providerModels);
    merged.repairAttempted ||= output.repairAttempted;
  }
  return merged;
}

export function reviewStatsForRuns(
  runs: PiRunStats[],
  durationMs: number,
): ReviewStats | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  const usage = aggregateReviewUsage(runs);
  return {
    models: collectReviewModels(runs),
    agentRuns: runs.length,
    durationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    usageStatus: usage.status,
  };
}

function collectReviewModels(runs: PiRunStats[]): string[] {
  const models: string[] = [];
  for (const model of runs.flatMap((run) => run.models)) {
    const sanitized = sanitizeReviewStatsModel(model);
    if (sanitized && models.length < maxReviewStatsModels && !models.includes(sanitized)) {
      models.push(sanitized);
    }
  }
  return models.length > 0 ? models : ["[invalid model]"];
}

function aggregateReviewUsage(runs: PiRunStats[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: ReviewStats["usageStatus"];
} {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let reportedRuns = 0;
  let partialUsage = false;
  for (const run of runs) {
    if (!run.usage) {
      continue;
    }
    reportedRuns += 1;
    const input = addReportedUsage(inputTokens, run.usage.inputTokens, Number.isSafeInteger);
    const output = addReportedUsage(outputTokens, run.usage.outputTokens, Number.isSafeInteger);
    const cost = addReportedUsage(costUsd, run.usage.costUsd, Number.isFinite);
    inputTokens = input.total;
    outputTokens = output.total;
    costUsd = cost.total;
    const sumsComplete = [input, output, cost].every((sum) => sum.complete);
    partialUsage ||= run.usage.status === "partial" || !sumsComplete;
  }
  return {
    inputTokens,
    outputTokens,
    costUsd,
    status:
      reportedRuns === 0
        ? "unavailable"
        : reportedRuns < runs.length || partialUsage
          ? "partial"
          : "complete",
  };
}

function addReportedUsage(
  current: number,
  reported: number,
  isValid: (value: number) => boolean,
): { total: number; complete: boolean } {
  const next = current + reported;
  return isValid(next) ? { total: next, complete: true } : { total: current, complete: false };
}

function mergeCommentContribution(
  merged: OutputState,
  comment: CommentContribution | undefined,
): void {
  if (!comment) {
    return;
  }
  assertOutputContributionAllowed(
    merged,
    "comment",
    comment.taskName,
    (existing, next) =>
      `ctx.comment(...) may be called once per selected run; received comments from '${existing}' and '${next}'`,
  );
  merged.comment = comment;
}

function mergeCommandResponseContribution(
  merged: OutputState,
  commandResponse: CommandResponseContribution | undefined,
): void {
  if (!commandResponse) {
    return;
  }
  assertOutputContributionAllowed(
    merged,
    "commandResponse",
    commandResponse.taskName,
    (existing, next) =>
      `ctx.command.reply(...) may be called once per selected run; received replies from '${existing}' and '${next}'`,
  );
  merged.commandResponse = commandResponse;
}

type OutputContributionKind = "comment" | "commandResponse";

function assertOutputContributionAllowed(
  state: OutputState,
  kind: OutputContributionKind,
  taskName: string,
  duplicateMessage: (existingTaskName: string, nextTaskName: string) => string,
): void {
  const existing = kind === "comment" ? state.comment : state.commandResponse;
  if (existing) {
    throw new Error(duplicateMessage(existing.taskName, taskName));
  }
  const opposite = kind === "comment" ? state.commandResponse : state.comment;
  if (opposite) {
    throw new Error("ctx.comment(...) and ctx.command.reply(...) cannot both be called");
  }
}

export function createCheckHandle(state: OutputState): CheckHandle {
  return {
    pass(summary) {
      setCheckResult(state, "success", summary);
    },
    fail(summary) {
      setCheckResult(state, "failure", summary);
    },
    neutral(summary) {
      setCheckResult(state, "neutral", summary);
    },
  };
}

function setCheckResult(
  state: OutputState,
  conclusion: RuntimeCheckConclusion,
  summary: string | undefined,
): void {
  if (state.check) {
    throw new Error("ctx.check may be completed at most once per task");
  }
  state.check = summary ? { conclusion, summary } : { conclusion };
}

export function runtimeTaskCheckResult(
  taskName: string,
  check: Omit<RuntimeTaskCheckResult, "taskName">,
): RuntimeTaskCheckResult {
  return check.summary
    ? { taskName, conclusion: check.conclusion, summary: check.summary }
    : { taskName, conclusion: check.conclusion };
}

export function collectComment(state: OutputState, value: CommentValue, taskName: string): void {
  assertOutputContributionAllowed(
    state,
    "comment",
    taskName,
    () =>
      `ctx.comment(...) may be called once per selected run; '${taskName}' called it more than once`,
  );
  state.comment = { taskName, value };
  if (typeof value === "string") {
    return;
  }
  collectInlineFindings(state, value.inlineFindings);
}

export function collectCommandResponse(state: OutputState, value: string, taskName: string): void {
  assertOutputContributionAllowed(
    state,
    "commandResponse",
    taskName,
    () =>
      `ctx.command.reply(...) may be called once per selected run; '${taskName}' called it more than once`,
  );
  state.commandResponse = { taskName, value };
}

export function priorReviewForTask(
  priorMainComment: string | undefined,
  priorReviewState: PriorReviewState | undefined,
): PriorReview {
  return {
    ...(priorMainComment ? { main: visibleMainComment(priorMainComment) } : {}),
    ...(priorReviewState ? { reviewedHeadSha: priorReviewState.reviewedHeadSha } : {}),
    inlineFindings:
      priorReviewState?.findings.map((finding) => ({
        id: finding.id,
        status: finding.status,
        path: finding.path,
        rangeId: finding.rangeId,
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
      })) ?? [],
  };
}

function visibleMainComment(body: string): string {
  const sourceLines = body.split("\n");
  const mainMarkerIndex = sourceLines.findIndex((line) =>
    line.startsWith("<!-- pipr:main-comment "),
  );
  const hiddenHeaderMarkerIndex =
    sourceLines[mainMarkerIndex + 2] === mainCommentHeaderHiddenMarker ? mainMarkerIndex + 2 : -1;
  const generatedFooterIndex = findGeneratedFooterIndex(sourceLines);
  const lastContentIndex = sourceLines
    .slice(0, generatedFooterIndex < 0 ? sourceLines.length : generatedFooterIndex)
    .findLastIndex((line) => line !== "");
  const hiddenStatsMarkerIndex =
    sourceLines[lastContentIndex] === reviewStatsHiddenMarker ? lastContentIndex : -1;
  const statsRange = generatedReviewStatsRange(sourceLines, generatedFooterIndex);
  const lines = sourceLines.filter((line, index) => {
    return (
      !(statsRange && index >= statsRange.start && index <= statsRange.end) &&
      index !== mainMarkerIndex &&
      index !== hiddenHeaderMarkerIndex &&
      index !== hiddenStatsMarkerIndex &&
      index !== generatedFooterIndex
    );
  });
  while (lines[0] === "") {
    lines.shift();
  }
  if (hiddenHeaderMarkerIndex < 0 && lines[0] && mainCommentTitles.has(lines[0])) {
    lines.shift();
  }
  while (lines[0] === "") {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function findGeneratedFooterIndex(lines: string[]): number {
  const index = lines.findLastIndex((line) => line !== "");
  const footer = lines[index] ?? "";
  return footer === mainCommentFooterHiddenMarker || mainCommentAttributionPattern.test(footer)
    ? index
    : -1;
}

function generatedReviewStatsRange(
  lines: string[],
  generatedFooterIndex: number,
): { start: number; end: number } | undefined {
  const end = lines
    .slice(0, generatedFooterIndex < 0 ? lines.length : generatedFooterIndex)
    .findLastIndex((line) => line !== "");
  if (end < 0) {
    return undefined;
  }
  if (lines[end] !== reviewStatsEndMarker) {
    return undefined;
  }
  if (lines[end - 1] !== "</details>") {
    return undefined;
  }
  const start = lines.lastIndexOf(reviewStatsStartMarker, end - 2);
  if (start < 0) {
    return undefined;
  }
  if (lines[start + 1] !== "<details>") {
    return undefined;
  }
  if (lines[start + 2] !== "<summary>Review stats</summary>") {
    return undefined;
  }
  if (!matchesGeneratedReviewStatsShape(lines, start, end)) {
    return undefined;
  }
  return { start, end };
}

function matchesGeneratedReviewStatsShape(lines: string[], start: number, end: number): boolean {
  const generatedShape = lines.slice(start + 3, end + 1);
  return (
    generatedShape.length === generatedReviewStatsShape.length &&
    generatedReviewStatsShape.every((pattern, index) => pattern.test(generatedShape[index] ?? ""))
  );
}

function collectInlineFindings(
  state: OutputState,
  findings: readonly ReviewFinding[] | undefined,
): void {
  if (!findings) {
    return;
  }
  const arrayScope = state.findingScopes.get(findings);
  state.findings.push(
    ...findings.map((finding) => ({
      finding,
      paths: arrayScope,
    })),
  );
}

export function trackResultFindingScope(
  state: OutputState,
  value: unknown,
  paths: PathFilter | undefined,
): void {
  if (!paths) {
    return;
  }
  const parsed = agentInlineFindingsOutputSchema.safeParse(value);
  if (parsed.success) {
    state.findingScopes.set(parsed.data.inlineFindings, paths);
  }
}

export function collectedReview(output: OutputState, summaryBody: string): ReviewResult {
  return {
    summary: { body: summaryBody },
    inlineFindings: output.findings.map((item) => item.finding),
  };
}
