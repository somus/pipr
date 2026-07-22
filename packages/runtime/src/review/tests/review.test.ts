import { describe, expect, it } from "bun:test";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { DiffManifest, ReviewResult } from "../../types.js";
import {
  parseReviewResult,
  reviewResultJsonSchema,
  reviewSchemaExample,
  validateReviewResult,
} from "../review.js";

const manifest = reviewTestManifest({ includeExcludedLock: true });

const baseReview: ReviewResult = {
  summary: { body: "Looks fine." },
  inlineFindings: [
    {
      body: "This can fail.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 11,
    },
  ],
};
const baseFinding = baseReview.inlineFindings[0];
if (!baseFinding) {
  throw new Error("test fixture missing base finding");
}

describe("validateReviewResult", () => {
  it("uses one Review Output for examples and runtime schema", () => {
    const example = parseReviewResult(reviewSchemaExample());

    expect(example.summary.body).toBe("Concise change request review summary.");
    expect(example.inlineFindings[0]?.suggestedFix).toBe("return safeValue;");
    expect(reviewResultJsonSchema).toMatchObject({
      type: "object",
      properties: {
        inlineFindings: { type: "array" },
      },
    });
    expect(reviewResultJsonSchema).not.toHaveProperty(["properties", "nonInlineFindings"]);
  });

  it("rejects reviewer output outside the published schema contract", () => {
    expect(() =>
      parseReviewResult({
        summary: { body: "Looks fine." },
      }),
    ).toThrow();
    expect(() =>
      parseReviewResult({
        summary: { body: "Looks fine.", extra: true },
        inlineFindings: [],
      }),
    ).toThrow();
    expect(() =>
      parseReviewResult({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parseReviewResult({
        summary: { body: "Looks fine." },
        inlineFindings: [{ ...baseFinding, suggestedFix: "" }],
      }),
    ).toThrow();
  });

  it("rejects non-inline findings in the MVP", () => {
    expect(() =>
      parseReviewResult({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [],
      }),
    ).toThrow();
    expect(() =>
      parseReviewResult({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [{ title: "Later" }],
      }),
    ).toThrow();
  });

  it("keeps findings inside a commentable range", () => {
    const validated = validateReviewResult(baseReview, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("canonicalizes an unusable range ID when the finding anchor matches one range", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [{ ...baseFinding, rangeId: "range-1-without-generated-suffix" }],
    };

    const validated = validateReviewResult(review, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toEqual([{ ...baseFinding, rangeId: "range-1" }]);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("canonicalizes a valid but mismatched range ID from the finding anchor", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [
        {
          ...baseFinding,
          rangeId: "range-1",
          startLine: 20,
          endLine: 21,
        },
      ],
    };

    const validated = validateReviewResult(review, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toEqual([
      {
        ...baseFinding,
        rangeId: "range-2",
        startLine: 20,
        endLine: 21,
      },
    ]);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("keeps an unusable range ID dropped when its anchor matches multiple ranges", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [{ ...baseFinding, rangeId: "range-without-a-unique-match" }],
    };

    const validated = validateReviewResult(review, overlappingRangeManifest(), {});

    expect(validated.validFindings).toHaveLength(0);
    expect(validated.droppedFindings).toEqual([
      {
        finding: review.inlineFindings[0],
        reason: "unknown rangeId 'range-without-a-unique-match'",
      },
    ]);
  });

  it("keeps scoped findings on renamed files when the filter matches the previous path", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [
        {
          ...baseFinding,
          path: "packages/new.ts",
          rangeId: "range-renamed",
          startLine: 1,
          endLine: 1,
        },
      ],
    };

    const validated = validateReviewResult(review, renamedManifest(), {
      pathScopeForFinding: () => ({ include: ["packages/old.ts"] }),
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("drops excluded-file findings", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [{ ...baseFinding, path: "bun.lock", rangeId: "range-lock" }],
    };

    const validated = validateReviewResult(review, manifest, {});

    expect(validated.validFindings).toHaveLength(0);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "file excluded from inline comments: lock file",
    ]);
  });

  it("drops semantic mismatches and duplicate fingerprints", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [
        { ...baseFinding, side: "LEFT" },
        { ...baseFinding, path: "src/other.ts" },
        { ...baseFinding, rangeId: "missing", startLine: 13, endLine: 13 },
        { ...baseFinding, startLine: 12, endLine: 11 },
        { ...baseFinding, startLine: 9 },
        baseFinding,
        baseFinding,
      ],
    };

    const validated = validateReviewResult(review, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "finding side does not match range side",
      "finding path does not match range path",
      "unknown rangeId 'missing'",
      "finding startLine is after endLine",
      "finding lines fall outside the commentable range",
      "duplicate finding fingerprint",
    ]);
  });

  it("keeps repeated finding bodies when they target different ranges", () => {
    const review: ReviewResult = {
      ...baseReview,
      inlineFindings: [
        baseFinding,
        {
          ...baseFinding,
          rangeId: "range-2",
          startLine: 20,
          endLine: 21,
        },
      ],
    };

    const validated = validateReviewResult(review, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(2);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("fails validation when the Diff Manifest head is stale", () => {
    expect(() =>
      validateReviewResult(baseReview, manifest, {
        expectedHeadSha: "new-head",
      }),
    ).toThrow("does not match expected head SHA");
  });
});

function renamedManifest(): DiffManifest {
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [
      {
        path: "packages/new.ts",
        previousPath: "packages/old.ts",
        status: "renamed",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            hunkIndex: 1,
            header: "@@ -1 +1 @@",
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            contentHash: "deadbeefcafe",
          },
        ],
        commentableRanges: [
          {
            id: "range-renamed",
            path: "packages/new.ts",
            side: "RIGHT",
            startLine: 1,
            endLine: 1,
            kind: "added",
            hunkIndex: 1,
            hunkHeader: "@@ -1 +1 @@",
            hunkContentHash: "deadbeefcafe",
          },
        ],
      },
    ],
  };
}

function overlappingRangeManifest(): DiffManifest {
  const file = manifest.files.find((candidate) => candidate.path === "src/a.ts");
  const range = file?.commentableRanges[0];
  if (!file || !range) {
    throw new Error("test fixture missing source range");
  }

  return {
    ...manifest,
    files: [
      {
        ...file,
        commentableRanges: [...file.commentableRanges, { ...range, id: "range-overlap" }],
      },
    ],
  };
}
