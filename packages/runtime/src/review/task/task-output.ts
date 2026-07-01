import type {
  CheckHandle,
  CommentValue,
  PathFilter,
  PriorReview,
  ReviewFinding,
} from "@usepipr/sdk";
import type { PrReview } from "../../types.js";
import type { PriorReviewState } from "../prior-state.js";

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

const findingScopeMarker: unique symbol = Symbol("pipr.findingScope");

type ScopedReviewFinding = ReviewFinding & {
  [findingScopeMarker]?: PathFilter;
};

export type TaskRunResult = {
  taskName: string;
  output: OutputState;
  error?: unknown;
};

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

function mergeCommentContribution(
  merged: OutputState,
  comment: CommentContribution | undefined,
): void {
  if (!comment) {
    return;
  }
  if (merged.comment) {
    throw new Error(
      `ctx.comment(...) may be called once per selected run; received comments from '${merged.comment.taskName}' and '${comment.taskName}'`,
    );
  }
  if (merged.commandResponse) {
    throw new Error("ctx.comment(...) and ctx.command.reply(...) cannot both be called");
  }
  merged.comment = comment;
}

function mergeCommandResponseContribution(
  merged: OutputState,
  commandResponse: CommandResponseContribution | undefined,
): void {
  if (!commandResponse) {
    return;
  }
  if (merged.commandResponse) {
    throw new Error(
      `ctx.command.reply(...) may be called once per selected run; received replies from '${merged.commandResponse.taskName}' and '${commandResponse.taskName}'`,
    );
  }
  if (merged.comment) {
    throw new Error("ctx.comment(...) and ctx.command.reply(...) cannot both be called");
  }
  merged.commandResponse = commandResponse;
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
  if (state.commandResponse) {
    throw new Error("ctx.comment(...) and ctx.command.reply(...) cannot both be called");
  }
  if (state.comment) {
    throw new Error(
      `ctx.comment(...) may be called once per selected run; '${taskName}' called it more than once`,
    );
  }
  state.comment = { taskName, value };
  if (typeof value === "string") {
    return;
  }
  collectInlineFindings(state, value.inlineFindings);
}

export function collectCommandResponse(state: OutputState, value: string, taskName: string): void {
  if (state.comment) {
    throw new Error("ctx.comment(...) and ctx.command.reply(...) cannot both be called");
  }
  if (state.commandResponse) {
    throw new Error(
      `ctx.command.reply(...) may be called once per selected run; '${taskName}' called it more than once`,
    );
  }
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
  const lines = body.split("\n").filter((line) => !line.startsWith("<!-- pipr:main-comment "));
  while (lines[0] === "") {
    lines.shift();
  }
  if (lines[0] === "# pipr Review") {
    lines.shift();
  }
  while (lines[0] === "") {
    lines.shift();
  }
  return lines.join("\n").trim();
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
      paths: (finding as ScopedReviewFinding)[findingScopeMarker] ?? arrayScope,
    })),
  );
}

export function trackResultFindingScope(
  state: OutputState,
  value: unknown,
  paths: PathFilter | undefined,
): void {
  if (!hasInlineFindings(value)) {
    return;
  }
  if (!paths) {
    return;
  }
  state.findingScopes.set(value.inlineFindings, paths);
  for (const finding of value.inlineFindings) {
    if (!isReviewFindingLike(finding)) {
      continue;
    }
    markFindingScope(finding, paths);
  }
}

function markFindingScope(finding: ReviewFinding, paths: PathFilter): void {
  Object.defineProperty(finding, findingScopeMarker, {
    value: paths,
    enumerable: true,
    configurable: true,
  });
}

function hasInlineFindings(value: unknown): value is { inlineFindings: readonly ReviewFinding[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { inlineFindings?: unknown }).inlineFindings)
  );
}

function isReviewFindingLike(value: unknown): value is ReviewFinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { body?: unknown }).body === "string" &&
    typeof (value as { path?: unknown }).path === "string" &&
    typeof (value as { rangeId?: unknown }).rangeId === "string"
  );
}

export function collectedReview(output: OutputState): PrReview {
  return {
    summary: { body: "Review completed." },
    inlineFindings: output.findings.map((item) => item.finding),
  };
}
