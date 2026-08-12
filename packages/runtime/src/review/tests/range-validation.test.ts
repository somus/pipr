import { describe, expect, it } from "bun:test";
import { createDiffRangeIndex } from "../../diff/ranges.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { CommentableRange, ReviewFinding } from "../../types.js";
import {
  assertFindingMatchesRange,
  findingRangeMismatchReason,
  matchFindingRange,
} from "../range-validation.js";

const manifest = reviewTestManifest();
const finding: ReviewFinding = {
  body: "This can fail.",
  path: "src/a.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 10,
  endLine: 11,
};

function rangeById(id: string): CommentableRange {
  const range = createDiffRangeIndex(manifest).rangeById(id);
  if (!range) {
    throw new Error(`test fixture missing range ${id}`);
  }
  return range;
}

describe("review range validation", () => {
  it("accepts findings that match a commentable range", () => {
    const range = rangeById("range-1");

    expect(findingRangeMismatchReason(finding, range)).toBeUndefined();
    expect(matchFindingRange(finding, range)).toEqual({ ok: true, value: range });
    expect(() => assertFindingMatchesRange(finding, range)).not.toThrow();
  });

  it("accepts a strict subrange inside the commentable range", () => {
    const range = rangeById("range-1");
    const widerRange: CommentableRange = {
      ...range,
      startLine: 9,
      endLine: 12,
    };

    expect(
      findingRangeMismatchReason({ ...finding, startLine: 11, endLine: 11 }, range),
    ).toBeUndefined();
    expect(
      findingRangeMismatchReason({ ...finding, startLine: 10, endLine: 12 }, widerRange),
    ).toBeUndefined();
  });

  it("rejects unknown and mismatched range anchors", () => {
    const range = rangeById("range-1");

    expect(findingRangeMismatchReason(finding, undefined)).toBe("unknown rangeId 'range-1'");
    expect(matchFindingRange(finding, undefined)).toEqual({
      ok: false,
      error: "unknown rangeId 'range-1'",
    });
    expect(findingRangeMismatchReason({ ...finding, rangeId: "range-2" }, range)).toBe(
      "finding rangeId does not match range",
    );
    expect(findingRangeMismatchReason({ ...finding, path: "src/other.ts" }, range)).toBe(
      "finding path does not match range path",
    );
    expect(findingRangeMismatchReason({ ...finding, side: "LEFT" }, range)).toBe(
      "finding side does not match range side",
    );
  });

  it("rejects inverted and out-of-bounds line spans", () => {
    const range = rangeById("range-1");
    const githubStyleRange: CommentableRange = {
      ...range,
      startLine: 9,
      endLine: 12,
    };

    expect(findingRangeMismatchReason({ ...finding, startLine: 12, endLine: 11 }, range)).toBe(
      "finding startLine is after endLine",
    );
    expect(findingRangeMismatchReason({ ...finding, startLine: 9, endLine: 11 }, range)).toBe(
      "finding lines fall outside the commentable range",
    );
    expect(findingRangeMismatchReason({ ...finding, startLine: 10, endLine: 13 }, range)).toBe(
      "finding lines fall outside the commentable range",
    );
    expect(
      findingRangeMismatchReason({ ...finding, startLine: 10, endLine: 13 }, githubStyleRange),
    ).toBe("finding lines fall outside the commentable range");
    expect(matchFindingRange({ ...finding, startLine: 10, endLine: 13 }, range)).toEqual({
      ok: false,
      error: "finding lines fall outside the commentable range",
    });
    expect(() =>
      assertFindingMatchesRange({ ...finding, startLine: 10, endLine: 13 }, range),
    ).toThrow("finding lines fall outside the commentable range");
  });
});
