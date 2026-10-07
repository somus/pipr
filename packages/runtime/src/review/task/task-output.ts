import { createHash } from "node:crypto";
import type {
  CheckHandle,
  DroppedReviewFinding,
  FindingFacets,
  PathFilter,
  PriorReview,
  ReviewFinding,
} from "@usepipr/sdk";
import { z } from "zod";
import type { PriorReviewState } from "../../publication/types.js";
import type { ReviewResult } from "../../types.js";
import { mainCommentTitles } from "../comment-branding.js";
import {
  type GeneratedMainCommentEnvelope,
  parseGeneratedMainCommentEnvelope,
} from "../main-comment-envelope.js";
import { findingFacetValues } from "../selection.js";
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
  droppedFindings: DroppedReviewFinding[];
  findingScopes: WeakMap<readonly ReviewFinding[], PathFilter>;
  /** Facet values of selected findings keyed by finding location. */
  findingFacets: Map<string, Record<string, string>>;
  providerModels: string[];
  repairAttempted: boolean;
  check?: Omit<RuntimeTaskCheckResult, "taskName">;
};

/** Comment value after Markdown helpers have been converted to strings. */
export type RuntimeCommentValue =
  | string
  | { main: string; inlineFindings?: readonly ReviewFinding[] }
  | { main?: never; inlineFindings: readonly ReviewFinding[] };

export type CommentContribution = {
  taskName: string;
  value: RuntimeCommentValue;
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

const metadataBearingReviewFindingSchema = z.looseObject({
  body: z.string().min(1),
  path: z.string().min(1),
  rangeId: z.string().min(1),
  side: z.enum(["RIGHT", "LEFT"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  suggestedFix: z.string().min(1).optional(),
});

const agentInlineFindingsOutputSchema = z.custom<{
  inlineFindings: readonly ReviewFinding[];
}>(
  (value) =>
    z
      .looseObject({
        inlineFindings: z.array(metadataBearingReviewFindingSchema),
      })
      .safeParse(value).success,
);

export function createOutputState(): OutputState {
  return {
    findings: [],
    droppedFindings: [],
    findingScopes: new WeakMap(),
    findingFacets: new Map(),
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
    merged.droppedFindings.push(...output.droppedFindings);
    merged.providerModels.push(...output.providerModels);
    merged.repairAttempted ||= output.repairAttempted;
  }
  return merged;
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
    gate(findings, options) {
      const failOn = options.failOn;
      const blocks =
        typeof failOn === "function"
          ? failOn
          : (finding: ReviewFinding) =>
              Object.entries(failOn).some(([key, values]) => {
                const value = (finding as Record<string, unknown>)[key];
                return typeof value === "string" && values.includes(value);
              });
      const blocking = findings.filter((finding) => blocks(finding));
      const summary = options.summary?.(blocking) ?? defaultGateSummary(blocking.length);
      setCheckResult(state, blocking.length > 0 ? "failure" : "success", summary);
      return { passed: blocking.length === 0, blocking };
    },
  };
}

function defaultGateSummary(blockingCount: number): string {
  if (blockingCount === 0) {
    return "No blocking findings.";
  }
  return `${blockingCount} blocking finding${blockingCount === 1 ? "" : "s"}.`;
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

export function collectComment(
  state: OutputState,
  value: RuntimeCommentValue,
  taskName: string,
): void {
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
      finding: canonicalFindingProjection(finding),
      paths: arrayScope,
    })),
  );
}

export function recordDroppedFindings(
  state: OutputState,
  droppedFindings: readonly DroppedReviewFinding[],
): void {
  state.droppedFindings.push(
    ...droppedFindings.map(({ finding, reason }) => ({
      finding: canonicalFindingProjection(finding),
      reason,
    })),
  );
}

export function recordFindingFacets(
  state: OutputState,
  findings: readonly ReviewFinding[],
  facets: FindingFacets,
): void {
  if (Object.keys(facets).length === 0) {
    return;
  }
  for (const finding of findings) {
    state.findingFacets.set(findingFacetKey(finding), findingFacetValues(finding, facets));
  }
}

/** Identifies one finding for facet tracking and outcome events; findings on the same lines differ by body. */
function findingFacetKey(finding: ReviewFinding): string {
  const body = createHash("sha256").update(finding.body).digest("hex").slice(0, 16);
  return [finding.path, finding.side, finding.startLine, finding.endLine, body].join(":");
}

function canonicalFindingProjection(finding: ReviewFinding): ReviewFinding {
  return {
    body: finding.body,
    path: finding.path,
    rangeId: finding.rangeId,
    side: finding.side,
    startLine: finding.startLine,
    endLine: finding.endLine,
    ...(finding.suggestedFix === undefined ? {} : { suggestedFix: finding.suggestedFix }),
  };
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
