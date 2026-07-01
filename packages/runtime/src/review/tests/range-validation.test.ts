import { describe, expect, it } from "bun:test";
import { createDiffRangeIndex } from "../../diff/ranges.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { ReviewFinding } from "../../types.js";
import { assertFindingMatchesRange, findingRangeMismatchReason } from "../range-validation.js";

const manifest = reviewTestManifest();
const finding: ReviewFinding = {
  body: "This can fail.",
  path: "src/a.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 10,
  endLine: 11,
};

describe("review range validation", () => {
  it("uses one finding-to-range rule", () => {
    const range = createDiffRangeIndex(manifest).rangeById("range-1");
    if (!range) {
      throw new Error("test fixture missing range");
    }

    expect(findingRangeMismatchReason(finding, range)).toBeUndefined();
    expect(() => assertFindingMatchesRange(finding, range)).not.toThrow();
    expect(findingRangeMismatchReason({ ...finding, side: "LEFT" }, range)).toBe(
      "finding side does not match range side",
    );
    expect(findingRangeMismatchReason({ ...finding, startLine: 12, endLine: 11 }, range)).toBe(
      "finding startLine is after endLine",
    );
  });
});
