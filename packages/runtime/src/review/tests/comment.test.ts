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
      }),
      metadata: metadata(),
    });

    expect(plan.mainComment).toContain("<!-- pipr:main-comment change=1 version=1 state=");
    expect(plan.mainComment).toContain("# Pipr Review\n\nSummary body.\n\nTests passed.");
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

  it("redacts secret-like tokens from the visible main comment body", () => {
    const plan = buildPublicationPlan({
      event,
      main: "A hard-coded secret was committed: pipr_eval_secret_do_not_repeat_12345.",
      inlineItems: [],
      metadata: metadata(),
    });

    expect(plan.mainComment).toContain("[redacted secret]");
    expect(plan.mainComment).not.toContain("pipr_eval_secret_do_not_repeat_12345");
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

  it("publishes suggested-change blocks when one selected line expands to multiple replacement lines", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            suggestedFix: ["if (failed) {", "  recover();", "}"].join("\n"),
          },
        ],
      },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBe(["if (failed) {", "  recover();", "}"].join("\n"));
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).toContain("```suggestion\nif (failed) {\n  recover();\n}\n```");
  });

  it("omits suggested-change blocks when a one-line selection keeps that line as context", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            startLine: 5,
            endLine: 5,
            suggestedFix: [
              "  const value = user.name ?? user.displayName;",
              "  if (!value) {",
              '    return "Anonymous";',
              "  }",
              "  return value.trim();",
            ].join("\n"),
          },
        ],
      },
      manifest: manifestWithRange(5, 5, "  return value.trim();"),
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("redacts secret-like tokens from inline bodies and strips leaking suggestions", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            body: "The literal pipr_eval_secret_do_not_repeat_12345 should not be repeated.",
            suggestedFix: 'const apiKey = "pipr_eval_secret_do_not_repeat_12345";',
          },
        ],
      },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(item?.finding.body).toContain("[redacted secret]");
    expect(item?.finding.body).not.toContain("pipr_eval_secret_do_not_repeat_12345");
    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).not.toContain("pipr_eval_secret_do_not_repeat_12345");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("uses publishable inline finding bodies for marker IDs and review state", () => {
    const rawFinding = {
      ...finding,
      body: "The literal pipr_eval_secret_do_not_repeat_12345 should not be repeated.",
      suggestedFix: 'const apiKey = "pipr_eval_secret_do_not_repeat_12345";',
    };
    const [item] = prepareInlinePublicationItems({
      validated: { validFindings: [rawFinding] },
      manifest,
      reviewedHeadSha: "head",
    });
    if (!item) {
      throw new Error("test fixture missing inline item");
    }
    const plan = buildPublicationPlan({
      event,
      main: "Summary.",
      inlineItems: [item],
      metadata: metadata(),
    });
    const state = extractPriorReviewState(plan.mainComment, 1);
    if (!state) {
      throw new Error("test fixture missing review state");
    }
    const markedState = applyInlineFindingMarkers(state, [item.body]);

    expect(state.findings[0]?.id).toBe(item.findingId);
    expect(markedState.findings[0]?.lastCommentedHeadSha).toBe("head");
    expect(
      prepareInlinePublicationItems({
        validated: { validFindings: [rawFinding] },
        manifest,
        reviewedHeadSha: "head",
        reviewState: markedState,
      }),
    ).toHaveLength(0);
  });

  it("skips inline drafts when body normalization leaves no publishable text", () => {
    const items = prepareInlinePublicationItems({
      validated: {
        validFindings: [{ ...finding, body: "   \n\t   " }],
      },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(items).toEqual([]);
  });

  it("publishes suggested-change blocks when a multi-line selection has a shorter replacement", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            endLine: 12,
            suggestedFix: "return safeCall();",
          },
        ],
      },
      manifest: manifestWithRange(10, 12, ["fail()", "recover()", "return"].join("\n")),
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBe("return safeCall();");
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).toContain("```suggestion\nreturn safeCall();\n```");
  });

  it("omits broad suggested-change blocks while keeping the finding", () => {
    const selectedLines = [
      "---",
      'title: "Changelog"',
      'description: "Release history for Pipr."',
      "---",
      "",
      "This changelog is generated from Conventional Commits by Release Please.",
      "",
      "## 0.2.2 (2026-07-06)",
      "",
      "### Features",
      "",
      "- harden review prompts and evals",
      ...Array.from({ length: 42 }, (_, index) => `release line ${index}`),
    ];
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            startLine: 1,
            endLine: selectedLines.length,
            suggestedFix: [
              "---",
              'title: "Changelog"',
              'description: "Release history for Pipr."',
              "---",
              "",
              "For the full release history, see CHANGELOG.md.",
            ].join("\n"),
          },
        ],
      },
      manifest: manifestWithRange(1, selectedLines.length, selectedLines.join("\n")),
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("omits suggested-change blocks when the selected preview is unavailable", () => {
    const [item] = prepareInlinePublicationItems({
      validated: { validFindings: [finding] },
      manifest: {
        ...manifest,
        files: manifest.files.map((file) => ({
          ...file,
          commentableRanges: file.commentableRanges.map((range) => ({
            ...range,
            preview: undefined,
          })),
        })),
      },
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("omits suggested-change blocks for left-side findings", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            side: "LEFT",
            suggestedFix: "safeCall();",
          },
        ],
      },
      manifest: {
        ...manifest,
        files: manifest.files.map((file) => ({
          ...file,
          commentableRanges: file.commentableRanges.map((range) => ({
            ...range,
            side: "LEFT",
            kind: "deleted",
          })),
        })),
      },
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("omits suggested-change blocks when the replacement includes unchanged edge lines", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            endLine: 14,
            suggestedFix: [
              "const next = compute();",
              "if (next < 0) {",
              "  return 0;",
              "}",
              "return next;",
            ].join("\n"),
          },
        ],
      },
      manifest: manifestWithRange(
        10,
        14,
        ["const next = compute();", "if (next < 0) {", "  return next;", "}", "return next;"].join(
          "\n",
        ),
      ),
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("omits suggested-change blocks when a one-line selection includes surrounding context", () => {
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            startLine: 11,
            endLine: 11,
            suggestedFix: [
              "const adjusted = priceCents - 100;",
              "return Math.max(0, adjusted);",
              "}",
            ].join("\n"),
          },
        ],
      },
      manifest: manifestWithRange(
        10,
        12,
        ["export function finalPrice(priceCents: number): number {", "return adjusted;", "}"].join(
          "\n",
        ),
      ),
      reviewedHeadSha: "head",
    });

    expect(item?.finding.suggestedFix).toBeUndefined();
    expect(item?.body).toContain("This can fail.");
    expect(item?.body).not.toContain("```suggestion");
  });

  it("publishes only a bounded first paragraph for verbose inline finding bodies", () => {
    const secondParagraph = "This second paragraph should not be published.";
    const [item] = prepareInlinePublicationItems({
      validated: {
        validFindings: [
          {
            ...finding,
            body: `${"The actionable issue is concise. ".repeat(40)}\n\n${secondParagraph}`,
          },
        ],
      },
      manifest,
      reviewedHeadSha: "head",
    });

    expect(item?.finding.body.length).toBeLessThanOrEqual(703);
    expect(item?.finding.body).toContain("The actionable issue is concise.");
    expect(item?.finding.body.endsWith("...")).toBe(true);
    expect(item?.body).not.toContain(secondParagraph);
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

function manifestWithRange(startLine: number, endLine: number, preview = "fail()"): DiffManifest {
  return {
    ...manifest,
    files: manifest.files.map((file) => ({
      ...file,
      commentableRanges: file.commentableRanges.map((range) => ({
        ...range,
        startLine,
        endLine,
        preview,
      })),
    })),
  };
}
