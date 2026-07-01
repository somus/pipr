import { describe, expect, it } from "bun:test";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { DiffManifest, PrReview } from "../../types.js";
import {
  parsePrReview,
  prReviewJsonSchema,
  reviewSchemaExample,
  validatePrReview,
} from "../review.js";

const manifest = reviewTestManifest({ includeExcludedLock: true });

const baseReview: PrReview = {
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

describe("validatePrReview", () => {
  it("uses one Review Output for examples and runtime schema", () => {
    const example = parsePrReview(reviewSchemaExample());

    expect(example.summary.body).toBe("Concise pull request review summary.");
    expect(example.inlineFindings[0]?.suggestedFix).toBe("return safeValue;");
    expect(prReviewJsonSchema).toMatchObject({
      type: "object",
      properties: {
        inlineFindings: { type: "array" },
      },
    });
    expect(prReviewJsonSchema).not.toHaveProperty(["properties", "nonInlineFindings"]);
  });

  it("rejects reviewer output outside the published schema contract", () => {
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
      }),
    ).toThrow();
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine.", extra: true },
        inlineFindings: [],
      }),
    ).toThrow();
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        extra: true,
      }),
    ).toThrow();
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [{ ...baseFinding, suggestedFix: "" }],
      }),
    ).toThrow();
  });

  it("rejects non-inline findings in the MVP", () => {
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [],
      }),
    ).toThrow();
    expect(() =>
      parsePrReview({
        summary: { body: "Looks fine." },
        inlineFindings: [],
        nonInlineFindings: [{ title: "Later" }],
      }),
    ).toThrow();
  });

  it("keeps findings inside a commentable range", () => {
    const validated = validatePrReview(baseReview, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("keeps scoped findings on renamed files when the filter matches the previous path", () => {
    const review: PrReview = {
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

    const validated = validatePrReview(review, renamedManifest(), {
      pathScopeForFinding: () => ({ include: ["packages/old.ts"] }),
    });

    expect(validated.validFindings).toHaveLength(1);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("drops excluded-file findings", () => {
    const review: PrReview = {
      ...baseReview,
      inlineFindings: [{ ...baseFinding, path: "bun.lock", rangeId: "range-lock" }],
    };

    const validated = validatePrReview(review, manifest, {});

    expect(validated.validFindings).toHaveLength(0);
    expect(validated.droppedFindings.map((drop) => drop.reason)).toEqual([
      "file excluded from inline comments: lock file",
    ]);
  });

  it("drops semantic mismatches and duplicate fingerprints", () => {
    const review: PrReview = {
      ...baseReview,
      inlineFindings: [
        { ...baseFinding, side: "LEFT" },
        { ...baseFinding, path: "src/other.ts" },
        { ...baseFinding, rangeId: "missing" },
        { ...baseFinding, startLine: 12, endLine: 11 },
        { ...baseFinding, startLine: 9 },
        baseFinding,
        baseFinding,
      ],
    };

    const validated = validatePrReview(review, manifest, {
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
    const review: PrReview = {
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

    const validated = validatePrReview(review, manifest, {
      expectedHeadSha: "head",
    });

    expect(validated.validFindings).toHaveLength(2);
    expect(validated.droppedFindings).toHaveLength(0);
  });

  it("fails validation when the Diff Manifest head is stale", () => {
    expect(() =>
      validatePrReview(baseReview, manifest, {
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
