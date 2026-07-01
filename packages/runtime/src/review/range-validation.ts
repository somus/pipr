import type { CommentableRange, ReviewFinding } from "../types.js";

export function assertFindingMatchesRange(finding: ReviewFinding, range: CommentableRange): void {
  const reason = findingRangeMismatchReason(finding, range);
  if (reason) {
    throw new Error(reason);
  }
}

export function findingRangeMismatchReason(
  finding: ReviewFinding,
  range: CommentableRange | undefined,
): string | undefined {
  if (!range) {
    return `unknown rangeId '${finding.rangeId}'`;
  }
  if (finding.rangeId !== range.id) {
    return "finding rangeId does not match range";
  }
  if (finding.path !== range.path) {
    return "finding path does not match range path";
  }
  if (finding.side !== range.side) {
    return "finding side does not match range side";
  }
  if (finding.startLine > finding.endLine) {
    return "finding startLine is after endLine";
  }
  if (finding.startLine < range.startLine || finding.endLine > range.endLine) {
    return "finding lines fall outside the commentable range";
  }
  return undefined;
}
