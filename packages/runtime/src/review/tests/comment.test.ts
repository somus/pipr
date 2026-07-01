import { describe, expect, it } from "bun:test";
import type { DiffManifest, ReviewFinding } from "../../types.js";
import { buildPublicationPlan, prepareInlinePublicationItems, runtimeVersion } from "../comment.js";
import {
  applyInlineFindingMarkers,
  buildPriorReviewState,
  extractInlineFindingMarkers,
  extractPriorReviewState,
} from "../prior-state.js";

const finding: ReviewFinding = {
  body: "This can fail.",
  path: "src/a.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 10,
  endLine: 10,
  suggestedFix: "Use a safe call.",
};

const manifest: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -10,1 +10,1 @@",
          oldStart: 10,
          oldLines: 1,
          newStart: 10,
          newLines: 1,
          contentHash: "deadbeefcafe",
        },
      ],
      commentableRanges: [
        {
          id: "range-1",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 10,
          endLine: 10,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -10,1 +10,1 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "fail()",
        },
      ],
    },
  ],
};

const event = {
  change: {
    number: 1,
    title: "",
    description: "",
    base: { sha: "base" },
    head: { sha: "head" },
  },
};

describe("comments", () => {
  it("renders one whole main comment body with review state", () => {
    const plan = buildPublicationPlan({
      event,
      main: "Summary body.\n\nTests passed.",
      inlineItems: [],
      reviewState: buildPriorReviewState({
        findings: [finding],
        reviewedHeadSha: "head",
        selectedTasks: ["review"],
      }).state,
      metadata: metadata(),
    });

    expect(plan.mainComment).toContain("<!-- pipr:main-comment change=1 version=1 state=");
    expect(plan.mainComment).toContain("# pipr Review\n\nSummary body.\n\nTests passed.");
    expect(plan.mainComment).not.toContain("pipr:contribution");
    expect(extractPriorReviewState(plan.mainComment, 1)?.findings[0]).not.toHaveProperty("body");
  });

  it("replaces the visible main comment body wholesale", () => {
    const plan = buildPublicationPlan({
      event,
      main: "New summary.",
      inlineItems: [],
      metadata: metadata(),
    });

    expect(plan.mainComment).toContain("New summary.");
    expect(plan.mainComment).not.toContain("Old summary.");
  });

  it("dedupes inline drafts with hidden markers", () => {
    const first = prepareInlinePublicationItems({
      validated: { validFindings: [finding] },
      manifest,
      reviewedHeadSha: "head",
    });
    const existing = first[0];
    if (!existing) {
      throw new Error("test fixture missing inline item");
    }
    const second = prepareInlinePublicationItems({
      validated: { validFindings: [finding] },
      manifest,
      reviewedHeadSha: "head",
      reviewState: {
        version: 1,
        reviewedHeadSha: "head",
        selectedTasks: ["review"],
        findings: [
          {
            id: existing.findingId,
            status: "open",
            path: existing.path,
            rangeId: existing.finding.rangeId,
            side: existing.side,
            startLine: existing.startLine,
            endLine: existing.endLine,
            firstSeenHeadSha: "head",
            lastSeenHeadSha: "head",
            lastCommentedHeadSha: "head",
          },
        ],
      },
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(extractInlineFindingMarkers(first.map((draft) => draft.body))).toEqual(
      new Set([`pipr:finding:${existing.findingId}:head`]),
    );
    expect(first[0]?.body).toContain("This can fail.");
    expect(first[0]?.body).toContain("```suggestion\nUse a safe call.\n```");
    expect(first[0]?.body).not.toContain("Suggested fix:");
  });

  it("omits suggested-change blocks when suggestedFix is absent", () => {
    const findingWithoutSuggestion = { ...finding };
    delete findingWithoutSuggestion.suggestedFix;
    const [item] = prepareInlinePublicationItems({
      validated: { validFindings: [findingWithoutSuggestion] },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("uses a longer suggestion fence when replacement code contains backticks", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [{ ...finding, suggestedFix: 'const fence = "```";' }],
      },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(item?.body).toContain('````suggestion\nconst fence = "```";\n````');
  });

  it("republishes inline drafts when the same-head inline comment was deleted", () => {
    const first = prepareInlinePublicationItems({
      validated: { validFindings: [finding] },
      manifest,
      reviewedHeadSha: "head",
    });
    const existing = first[0];
    if (!existing) {
      throw new Error("test fixture missing inline item");
    }
    const state = applyInlineFindingMarkers(
      {
        version: 1,
        reviewedHeadSha: "head",
        selectedTasks: ["review"],
        findings: [
          {
            id: existing.findingId,
            status: "open",
            path: existing.path,
            rangeId: existing.finding.rangeId,
            side: existing.side,
            startLine: existing.startLine,
            endLine: existing.endLine,
            firstSeenHeadSha: "head",
            lastSeenHeadSha: "head",
            lastCommentedHeadSha: "head",
          },
        ],
      },
      [],
    );

    expect(state.findings[0]?.lastCommentedHeadSha).toBeUndefined();
    expect(
      prepareInlinePublicationItems({
        validated: { validFindings: [finding] },
        manifest,
        reviewedHeadSha: "head",
        reviewState: state,
      }),
    ).toHaveLength(1);
  });
});

function metadata() {
  return {
    runtimeVersion,
    reviewedHeadSha: "head",
    providerModels: ["deepseek-v4-pro"],
    selectedTasks: ["review"],
    failedTasks: [],
    validFindings: 1,
    droppedFindings: 0,
  };
}
