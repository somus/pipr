import type {
  CheckHandle,
  CommentValue,
  PathFilter,
  PiprRunSummary,
  PriorReview,
  ReviewFinding,
} from "@usepipr/sdk";
import { z } from "zod";
import { summarizeDiffContextCoverage } from "../../pi/diff-context-coverage.js";
import type { ReviewResult } from "../../types.js";
import type { PiRunStats } from "../agent/review-run.js";
import { mainCommentTitles } from "../comment-branding.js";
import { reviewFindingSchema } from "../contract.js";
import {
  type GeneratedMainCommentEnvelope,
  parseGeneratedMainCommentEnvelope,
} from "../main-comment-envelope.js";
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
  const coverage = runs.map((run) => run.diffContextCoverage).filter((item) => item !== undefined);
  return {
    models: collectReviewModels(runs),
    agentRuns: runs.length,
    durationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    usageStatus: usage.status,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheUsageStatus: usage.cacheStatus,
    ...(coverage.length > 0 ? { diffContextCoverage: summarizeDiffContextCoverage(coverage) } : {}),
  };
}

export function runSummaryStatsFields(
  stats: ReviewStats | undefined,
): Pick<
  PiprRunSummary,
  | "agentRuns"
  | "inputTokens"
  | "outputTokens"
  | "costUsd"
  | "usageStatus"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheUsageStatus"
  | "diffContextCoverage"
> {
  return {
    agentRuns: stats?.agentRuns ?? 0,
    inputTokens: stats?.inputTokens ?? 0,
    outputTokens: stats?.outputTokens ?? 0,
    costUsd: stats?.costUsd ?? 0,
    usageStatus: stats?.usageStatus ?? "unavailable",
    cacheReadTokens: stats?.cacheReadTokens ?? 0,
    cacheWriteTokens: stats?.cacheWriteTokens ?? 0,
    cacheUsageStatus: stats?.cacheUsageStatus ?? "unavailable",
    ...(stats?.diffContextCoverage ? { diffContextCoverage: stats.diffContextCoverage } : {}),
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
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheStatus: NonNullable<ReviewStats["cacheUsageStatus"]>;
} {
  return { ...aggregateCoreUsage(runs), ...aggregateCacheUsage(runs) };
}

function aggregateCoreUsage(runs: PiRunStats[]): {
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
    if (!run.usage) continue;
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
    status: aggregateUsageStatus(reportedRuns, runs.length, partialUsage),
  };
}

function aggregateCacheUsage(runs: PiRunStats[]): {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheStatus: NonNullable<ReviewStats["cacheUsageStatus"]>;
} {
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reportedRuns = 0;
  let partialUsage = false;
  for (const run of runs) {
    if (!hasReportedCacheUsage(run)) continue;
    const usage = run.usage;
    reportedRuns += 1;
    const cacheRead = addReportedUsage(
      cacheReadTokens,
      usage.cacheReadTokens,
      Number.isSafeInteger,
    );
    const cacheWrite = addReportedUsage(
      cacheWriteTokens,
      usage.cacheWriteTokens,
      Number.isSafeInteger,
    );
    cacheReadTokens = cacheRead.total;
    cacheWriteTokens = cacheWrite.total;
    partialUsage ||=
      usage.cacheUsageStatus === "partial" || !cacheRead.complete || !cacheWrite.complete;
  }
  return {
    cacheReadTokens,
    cacheWriteTokens,
    cacheStatus: aggregateUsageStatus(reportedRuns, runs.length, partialUsage),
  };
}

function hasReportedCacheUsage(run: PiRunStats): run is PiRunStats & {
  usage: PiRunStats["usage"] & {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheUsageStatus: "complete" | "partial";
  };
} {
  return (
    run.usage?.cacheReadTokens !== undefined &&
    run.usage.cacheWriteTokens !== undefined &&
    run.usage.cacheUsageStatus !== undefined &&
    run.usage.cacheUsageStatus !== "unavailable"
  );
}

function aggregateUsageStatus(
  reported: number,
  total: number,
  partial: boolean,
): "complete" | "partial" | "unavailable" {
  if (reported === 0) return "unavailable";
  return reported < total || partial ? "partial" : "complete";
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
  if (value.main === undefined && value.inlineFindings === undefined) {
    throw new Error("ctx.comment(...) requires main or inlineFindings");
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
  const visibleMain = priorMainComment ? visibleMainComment(priorMainComment) : undefined;
  return {
    ...(visibleMain ? { main: visibleMain } : {}),
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
  const envelope = parseGeneratedMainCommentEnvelope(sourceLines);
  const lines = sourceLines.filter((_line, index) => !generatedEnvelopeOwnsLine(envelope, index));
  while (lines[0] === "") {
    lines.shift();
  }
  if (envelope.headerMarkerIndex < 0 && lines[0] && mainCommentTitles.has(lines[0])) {
    lines.shift();
  }
  while (lines[0] === "") {
    lines.shift();
  }
  return lines.join("\n").trim();
}

function generatedEnvelopeOwnsLine(envelope: GeneratedMainCommentEnvelope, index: number): boolean {
  if (
    [
      envelope.mainMarkerIndex,
      envelope.headerMarkerIndex,
      envelope.statsMarkerIndex,
      envelope.footerIndex,
    ].includes(index)
  ) {
    return true;
  }
  return [envelope.statsRange, envelope.progressRange, envelope.resultRange].some(
    (range) => range !== undefined && index >= range.start && index <= range.end,
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
