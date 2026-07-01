import { describe, expect, it } from "bun:test";
import type { DiffManifest, ValidatedReview } from "../../types.js";
import { runtimeVersion } from "../comment.js";
import { buildCommentPublishingPlan } from "../comment-publishing.js";
import type { PriorReviewState } from "../prior-state.js";

const event = {
  change: {
    number: 1,
    title: "",
    description: "",
    base: { sha: "base" },
    head: { sha: "head" },
  },
};

const manifest: DiffManifest = {
  baseSha: "base",
  headSha: "head",
  mergeBaseSha: "base",
  files: [
    {
      path: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      hunks: [
        {
          hunkIndex: 1,
          header: "@@ -10,2 +10,2 @@",
          oldStart: 10,
          oldLines: 2,
          newStart: 10,
          newLines: 2,
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
          hunkHeader: "@@ -10,2 +10,2 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "fail()",
        },
        {
          id: "range-2",
          path: "src/a.ts",
          side: "RIGHT",
          startLine: 11,
          endLine: 11,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -10,2 +10,2 @@",
          hunkContentHash: "deadbeefcafe",
          preview: "break()",
        },
      ],
    },
  ],
};

const validated: ValidatedReview = {
  review: { summary: { body: "Review completed." }, inlineFindings: [] },
  validFindings: [
    finding("First finding.", "range-1", 10),
    finding("Second finding.", "range-2", 11),
  ],
  droppedFindings: [],
};

describe("buildCommentPublishingPlan", () => {
  it("assembles one main comment and returns capped inline drafts", () => {
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Summary body.\n\nExtra details.",
      validated,
      manifest,
      maxInlineComments: 1,
      metadata: {
        runtimeVersion,
        reviewedHeadSha: event.change.head.sha,
        providerModels: ["deepseek-v4-pro"],
        selectedTasks: ["review"],
        failedTasks: [],
        validFindings: 2,
        droppedFindings: 0,
      },
    });

    expect(publishing.publicationPlan.mainComment).toContain("Summary body.");
    expect(publishing.publicationPlan.mainComment).toContain("Extra details.");
    expect(publishing.publicationPlan.metadata.cappedInlineFindings).toBe(1);
    expect(publishing.publicationPlan.inlineItems).toHaveLength(1);
    expect(publishing.inlineCommentDrafts).toEqual(publishing.publicationPlan.inlineItems);
    expect(publishing.inlineCommentDrafts[0]?.finding.body).toBe("First finding.");
  });

  it("keeps current findings visible when stored prior state is capped", () => {
    const currentFindings = manyFindings(101);
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: currentFindings },
      manifest: manifestForFindings(currentFindings),
      metadata: metadata({ validFindings: currentFindings.length }),
    });

    expect(publishing.publicationPlan.reviewState.findings).toHaveLength(101);
    expect(publishing.publicationPlan.mainComment).toContain("Review completed.");
  });

  it("keeps prior open findings on same-head reruns when the agent omits them", () => {
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [] },
      manifest,
      priorReviewState: priorState({ reviewedHeadSha: "head", lastCommentedHeadSha: "head" }),
      metadata: metadata({ validFindings: 0 }),
    });

    expect(publishing.inlineCommentDrafts).toHaveLength(0);
    expect(publishing.publicationPlan.reviewState.findings[0]).toMatchObject({
      id: "fnd_existing",
      status: "open",
      lastSeenHeadSha: "head",
    });
    expect(publishing.publicationPlan.mainComment).toContain("Review completed.");
  });

  it("keeps prior open findings open until the verifier resolves them", () => {
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [] },
      manifest,
      priorReviewState: priorState({ reviewedHeadSha: "old-head", lastSeenHeadSha: "old-head" }),
      metadata: metadata({ validFindings: 0 }),
    });

    expect(publishing.publicationPlan.reviewState.findings[0]).toMatchObject({
      id: "fnd_existing",
      status: "open",
      lastSeenHeadSha: "old-head",
    });
    expect(publishing.publicationPlan.mainComment).toContain("Review completed.");
    expect(publishing.publicationPlan.mainComment).not.toContain("[resolved]");
    expect(publishing.publicationPlan.mainComment).not.toContain("- Prior finding.");
  });

  it("does not carry prior findings from another selected task scope", () => {
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [] },
      manifest,
      priorReviewState: {
        ...priorState({ reviewedHeadSha: "old-head", lastSeenHeadSha: "old-head" }),
        selectedTasks: ["security"],
      },
      metadata: metadata({ validFindings: 0 }),
    });

    expect(publishing.publicationPlan.reviewState.findings).toEqual([]);
    expect(publishing.publicationPlan.mainComment).toContain("Review completed.");
  });

  it("does not reuse ambiguous same-range prior ids for unrelated current findings", () => {
    const currentFinding = finding("Current finding.", "range-1", 10);
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: [priorFindingRecord("fnd_prior_a"), priorFindingRecord("fnd_prior_b")],
      },
      metadata: metadata({ validFindings: 1 }),
    });

    const current = publishing.publicationPlan.reviewState.findings.find(
      (finding) => !finding.id.startsWith("fnd_prior_"),
    );
    const draft = publishing.inlineCommentDrafts[0];
    if (!current || !draft) {
      throw new Error("test fixture missing current finding");
    }

    expect(current.id).not.toBe("fnd_prior_a");
    expect(current.id).not.toBe("fnd_prior_b");
    expect(draft.findingId).toBe(current.id);
    expect(
      publishing.publicationPlan.reviewState.findings
        .filter((finding) => finding.id.startsWith("fnd_prior_"))
        .map((finding) => finding.status),
    ).toEqual(["open", "open"]);
  });
});

function metadata(options: { validFindings: number }) {
  return {
    runtimeVersion,
    reviewedHeadSha: event.change.head.sha,
    providerModels: ["deepseek-v4-pro"],
    selectedTasks: ["review"],
    failedTasks: [],
    validFindings: options.validFindings,
    droppedFindings: 0,
  };
}

function priorState(options: {
  reviewedHeadSha: string;
  lastSeenHeadSha?: string;
  lastCommentedHeadSha?: string;
}): PriorReviewState {
  return {
    version: 1,
    reviewedHeadSha: options.reviewedHeadSha,
    selectedTasks: ["review"],
    findings: [
      {
        ...priorFindingRecord("fnd_existing"),
        firstSeenHeadSha: "old-head",
        lastSeenHeadSha: options.lastSeenHeadSha ?? "head",
        lastCommentedHeadSha: options.lastCommentedHeadSha,
      },
    ],
  };
}

function priorFindingRecord(id: string): PriorReviewState["findings"][0] {
  return {
    id,
    status: "open",
    path: "src/a.ts",
    rangeId: "range-1",
    side: "RIGHT",
    startLine: 10,
    endLine: 10,
    firstSeenHeadSha: "old-head",
    lastSeenHeadSha: "old-head",
  };
}

function manyFindings(count: number): ValidatedReview["validFindings"] {
  return Array.from({ length: count }, (_, index) =>
    finding(`Finding ${index + 1}.`, `range-${index + 1}`, index + 1),
  );
}

function finding(body: string, rangeId: string, line: number): ValidatedReview["validFindings"][0] {
  return {
    body,
    path: "src/a.ts",
    rangeId,
    side: "RIGHT",
    startLine: line,
    endLine: line,
  };
}

function manifestForFindings(findings: ValidatedReview["validFindings"]): DiffManifest {
  return {
    ...manifest,
    files: [
      {
        ...manifest.files[0],
        additions: findings.length,
        hunks: [
          {
            hunkIndex: 1,
            header: `@@ -1,1 +1,${findings.length} @@`,
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: findings.length,
            contentHash: "abc123abc123",
          },
        ],
        commentableRanges: findings.map((finding) => ({
          id: finding.rangeId,
          path: finding.path,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: `@@ -1,1 +1,${findings.length} @@`,
          hunkContentHash: "abc123abc123",
          preview: finding.body,
        })),
      },
    ],
  };
}
