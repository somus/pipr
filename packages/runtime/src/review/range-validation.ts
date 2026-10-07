import type { FindingDropCode } from "@usepipr/sdk";
import type { CommentableRange, ReviewFinding } from "../types.js";

/** Why a finding was dropped: a content-free code for outcome events and a message for logs. */
export type FindingDropReason = { code: FindingDropCode; message: string };

export function assertFindingMatchesRange(finding: ReviewFinding, range: CommentableRange): void {
  const mismatch = findingRangeMismatch(finding, range);
  if (mismatch) {
    throw new Error(mismatch.message);
  }
}

export function findingRangeMismatch(
  finding: ReviewFinding,
  range: CommentableRange | undefined,
): FindingDropReason | undefined {
  if (!range) {
    return { code: "unknown-range", message: `unknown rangeId '${finding.rangeId}'` };
  }
  if (finding.rangeId !== range.id) {
    return { code: "range-mismatch", message: "finding rangeId does not match range" };
  }
  if (finding.path !== range.path) {
    return { code: "path-mismatch", message: "finding path does not match range path" };
  }
  if (finding.side !== range.side) {
    return { code: "side-mismatch", message: "finding side does not match range side" };
  }
  if (finding.startLine > finding.endLine) {
    return { code: "inverted-lines", message: "finding startLine is after endLine" };
  }
  if (finding.startLine < range.startLine || finding.endLine > range.endLine) {
    return {
      code: "out-of-range",
      message: "finding lines fall outside the commentable range",
    };
  }
  return undefined;
}
