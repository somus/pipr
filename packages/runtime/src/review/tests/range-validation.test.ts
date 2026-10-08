import { describe, expect, it } from "bun:test";
import { createDiffRangeIndex } from "../../diff/ranges.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { CommentableRange, ReviewFinding } from "../../types.js";
import { assertFindingMatchesRange, findingRangeMismatch } from "../range-validation.js";

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
  const range = createDiffRangeIndex(manifest).findRange(id)?.range;
  if (!range) {
    throw new Error(`test fixture missing range ${id}`);
  }
  return range;
}

const outOfRange = {
  code: "out-of-range" as const,
  message: "finding lines fall outside the commentable range",
};

describe("review range validation", () => {
  it("accepts findings that match a commentable range", () => {
    const range = rangeById("range-1");

    expect(findingRangeMismatch(finding, range)).toBeUndefined();
    expect(() => assertFindingMatchesRange(finding, range)).not.toThrow();
  });

  it("accepts a strict subrange inside the commentable range", () => {
    const range = rangeById("range-1");
    const widerRange: CommentableRange = {
      ...range,
      startLine: 9,
      endLine: 12,
    };

    expect(findingRangeMismatch({ ...finding, startLine: 11, endLine: 11 }, range)).toBeUndefined();
    expect(
      findingRangeMismatch({ ...finding, startLine: 10, endLine: 12 }, widerRange),
    ).toBeUndefined();
  });

  it("rejects unknown and mismatched range anchors", () => {
    const range = rangeById("range-1");

    expect(findingRangeMismatch(finding, undefined)).toEqual({
      code: "unknown-range",
      message: "unknown rangeId 'range-1'",
    });
    expect(findingRangeMismatch({ ...finding, rangeId: "range-2" }, range)).toEqual({
      code: "range-mismatch",
      message: "finding rangeId does not match range",
    });
    expect(findingRangeMismatch({ ...finding, path: "src/other.ts" }, range)).toEqual({
      code: "path-mismatch",
      message: "finding path does not match range path",
    });
    expect(findingRangeMismatch({ ...finding, side: "LEFT" }, range)).toEqual({
      code: "side-mismatch",
      message: "finding side does not match range side",
    });
  });

  it("rejects inverted and out-of-bounds line spans", () => {
    const range = rangeById("range-1");
    const githubStyleRange: CommentableRange = {
      ...range,
      startLine: 9,
      endLine: 12,
    };

    expect(findingRangeMismatch({ ...finding, startLine: 12, endLine: 11 }, range)).toEqual({
      code: "inverted-lines",
      message: "finding startLine is after endLine",
    });
    expect(findingRangeMismatch({ ...finding, startLine: 9, endLine: 11 }, range)).toEqual(
      outOfRange,
    );
    expect(findingRangeMismatch({ ...finding, startLine: 10, endLine: 13 }, range)).toEqual(
      outOfRange,
    );
    expect(
      findingRangeMismatch({ ...finding, startLine: 10, endLine: 13 }, githubStyleRange),
    ).toEqual(outOfRange);
    expect(() =>
      assertFindingMatchesRange({ ...finding, startLine: 10, endLine: 13 }, range),
    ).toThrow("finding lines fall outside the commentable range");
  });
});
