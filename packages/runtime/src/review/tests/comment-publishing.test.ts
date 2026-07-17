import { describe, expect, it } from "bun:test";
import type { DiffManifest, ValidatedReview } from "../../types.js";
import { runtimeVersion } from "../comment.js";
import { buildCommentPublishingPlan } from "../comment-publishing.js";
import { extractPriorReviewState, type PriorReviewState } from "../prior-state.js";

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

  it("keeps current findings visible while serialized prior state is capped", () => {
    const currentFindings = manyFindings(101);
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: currentFindings },
      manifest: manifestForFindings(currentFindings),
      metadata: metadata({ validFindings: currentFindings.length }),
    });

    expect(publishing.publicationPlan.reviewState.findings).toHaveLength(101);
    expect(publishing.inlineCommentDrafts).toHaveLength(101);
    expect(
      extractPriorReviewState(publishing.publicationPlan.mainComment, event.change.number)
        ?.findings,
    ).toHaveLength(50);
    expect(publishing.publicationPlan.mainComment).toContain("Review completed.");
  });

  it("supports the maximum stored finding limit", () => {
    const currentFindings = manyFindings(101);
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: currentFindings },
      manifest: manifestForFindings(currentFindings),
      maxStoredFindings: 100,
      metadata: metadata({ validFindings: currentFindings.length }),
    });

    expect(
      extractPriorReviewState(publishing.publicationPlan.mainComment, event.change.number)
        ?.findings,
    ).toHaveLength(100);
  });

  it("can serialize no finding records without hiding current findings", () => {
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated,
      manifest,
      maxStoredFindings: 0,
      metadata: metadata({ validFindings: validated.validFindings.length }),
    });

    expect(publishing.publicationPlan.reviewState.findings).toHaveLength(2);
    expect(publishing.inlineCommentDrafts).toHaveLength(2);
    expect(
      extractPriorReviewState(publishing.publicationPlan.mainComment, event.change.number),
    ).toMatchObject({
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      findings: [],
    });
  });

  it("serializes current findings before historical findings without capping active state", () => {
    const historicalFindings = Array.from({ length: 100 }, (_, index) =>
      priorFindingRecord(`fnd_prior_${index + 1}`),
    );
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated,
      manifest,
      maxStoredFindings: 3,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: historicalFindings,
      },
      metadata: metadata({ validFindings: validated.validFindings.length }),
    });

    expect(publishing.publicationPlan.reviewState.findings).toHaveLength(102);
    const currentIds = publishing.publicationPlan.reviewState.findings
      .slice(0, 2)
      .map((finding) => finding.id);
    expect(
      extractPriorReviewState(
        publishing.publicationPlan.mainComment,
        event.change.number,
      )?.findings.map((finding) => finding.id),
    ).toEqual([...currentIds, "fnd_prior_1"]);
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

  it("does not republish a resolved issue when its selected code is unchanged", () => {
    const initialFinding = finding("Portability concern.", "range-1", 10);
    const initial = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [initialFinding] },
      manifest,
      metadata: metadata({ validFindings: 1 }),
    });
    const persisted = extractPriorReviewState(
      initial.publicationPlan.mainComment,
      event.change.number,
    );
    if (!persisted) {
      throw new Error("test fixture missing persisted prior review state");
    }
    expect(persisted.findings[0]?.anchorFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted.findings[0]?.issueFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const currentFinding = {
      ...finding("**PORTABILITY concern**", "range-moved", 20),
      path: "src/moved.ts",
    };
    const movedManifest: DiffManifest = {
      ...manifest,
      files: manifest.files.map((file) => ({
        ...file,
        path: "src/moved.ts",
        previousPath: "src/a.ts",
        commentableRanges: file.commentableRanges.map((range) =>
          range.id === "range-1"
            ? {
                ...range,
                id: "range-moved",
                path: "src/moved.ts",
                startLine: 20,
                endLine: 20,
                preview: "fail()  \r\n",
              }
            : range,
        ),
      })),
    };
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest: movedManifest,
      priorReviewState: {
        ...persisted,
        findings: persisted.findings.map((finding) => ({
          ...finding,
          status: "resolved" as const,
          lastCommentedHeadSha: "old-head",
        })),
      },
      metadata: metadata({ validFindings: 1 }),
    });

    expect(publishing.inlineCommentDrafts).toEqual([]);
    expect(publishing.publicationPlan.reviewState.findings).toContainEqual(
      expect.objectContaining({
        id: persisted.findings[0]?.id,
        status: "resolved",
        lastSeenHeadSha: "head",
      }),
    );
  });

  it("republishes a resolved issue when its selected code changes", () => {
    const currentFinding = finding("Portability concern.", "range-1", 10);
    const changedManifest: DiffManifest = {
      ...manifest,
      files: manifest.files.map((file) => ({
        ...file,
        commentableRanges: file.commentableRanges.map((range) =>
          range.id === "range-1" ? { ...range, preview: "portableSleep()" } : range,
        ),
      })),
    };
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest: changedManifest,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: [
          {
            ...priorFindingRecord("fnd_existing"),
            status: "resolved",
            anchorFingerprint: "86448157c1881ef7d519d770d26477f8aae2b01f20054b52b9c4773b0cd05447",
            issueFingerprint: "b7f0aa536a14f921817a528b4894277a4cca0e11b2adb0f593763b105b09d2f8",
            lastCommentedHeadSha: "old-head",
          },
        ],
      },
      metadata: metadata({ validFindings: 1 }),
    });

    expect(publishing.inlineCommentDrafts).toHaveLength(1);
    expect(publishing.publicationPlan.reviewState.findings[0]).toMatchObject({ status: "open" });
  });

  it("publishes identical selected code from an unrelated path", () => {
    const currentFinding = { ...finding("Different concern.", "range-1", 10), path: "src/b.ts" };
    const otherPathManifest: DiffManifest = {
      ...manifest,
      files: manifest.files.map((file) => ({
        ...file,
        path: "src/b.ts",
        commentableRanges: file.commentableRanges.map((range) => ({
          ...range,
          path: "src/b.ts",
        })),
      })),
    };
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest: otherPathManifest,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: [
          {
            ...priorFindingRecord("fnd_existing"),
            status: "resolved",
            anchorFingerprint: "86448157c1881ef7d519d770d26477f8aae2b01f20054b52b9c4773b0cd05447",
            issueFingerprint: "b7f0aa536a14f921817a528b4894277a4cca0e11b2adb0f593763b105b09d2f8",
            lastCommentedHeadSha: "old-head",
          },
        ],
      },
      metadata: metadata({ validFindings: 1 }),
    });

    expect(publishing.inlineCommentDrafts).toHaveLength(1);
    expect(publishing.publicationPlan.reviewState.findings).toContainEqual(
      expect.objectContaining({ path: "src/b.ts", status: "open" }),
    );
  });

  it("publishes a different concern on the same selected code", () => {
    const currentFinding = finding("Error handling concern.", "range-1", 10);
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: [
          {
            ...priorFindingRecord("fnd_existing"),
            status: "resolved",
            anchorFingerprint: "86448157c1881ef7d519d770d26477f8aae2b01f20054b52b9c4773b0cd05447",
            issueFingerprint: "b7f0aa536a14f921817a528b4894277a4cca0e11b2adb0f593763b105b09d2f8",
            lastCommentedHeadSha: "old-head",
          },
        ],
      },
      metadata: metadata({ validFindings: 1 }),
    });

    expect(publishing.inlineCommentDrafts).toHaveLength(1);
    expect(publishing.publicationPlan.reviewState.findings).toContainEqual(
      expect.objectContaining({ status: "open", lastSeenHeadSha: "head" }),
    );
  });

  it("publishes ambiguous current concerns that select the same resolved code", () => {
    const currentFindings = [
      finding("Portability concern.", "range-1", 10),
      finding("**PORTABILITY CONCERN**", "range-1", 10),
    ];
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: currentFindings },
      manifest,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: [
          {
            ...priorFindingRecord("fnd_existing"),
            status: "resolved",
            anchorFingerprint: "86448157c1881ef7d519d770d26477f8aae2b01f20054b52b9c4773b0cd05447",
            issueFingerprint: "b7f0aa536a14f921817a528b4894277a4cca0e11b2adb0f593763b105b09d2f8",
            lastCommentedHeadSha: "old-head",
          },
        ],
      },
      metadata: metadata({ validFindings: currentFindings.length }),
    });

    expect(publishing.inlineCommentDrafts).toHaveLength(2);
    expect(publishing.publicationPlan.reviewState.findings).toContainEqual(
      expect.objectContaining({ id: "fnd_existing", status: "resolved" }),
    );
  });

  it("publishes when multiple resolved findings have the same selected code", () => {
    const currentFinding = finding("Portability concern.", "range-1", 10);
    const resolvedFinding = {
      ...priorFindingRecord("fnd_prior_1"),
      status: "resolved" as const,
      anchorFingerprint: "86448157c1881ef7d519d770d26477f8aae2b01f20054b52b9c4773b0cd05447",
      issueFingerprint: "b7f0aa536a14f921817a528b4894277a4cca0e11b2adb0f593763b105b09d2f8",
      lastCommentedHeadSha: "old-head",
    };
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest,
      priorReviewState: {
        version: 1,
        reviewedHeadSha: "old-head",
        selectedTasks: ["review"],
        findings: [resolvedFinding, { ...resolvedFinding, id: "fnd_prior_2" }],
      },
      metadata: metadata({ validFindings: 1 }),
    });

    expect(publishing.inlineCommentDrafts).toHaveLength(1);
    expect(publishing.publicationPlan.reviewState.findings).toContainEqual(
      expect.objectContaining({ status: "open", lastSeenHeadSha: "head" }),
    );
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
      priorReviewState: ambiguousPriorState(),
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

  it("uses publishable findings for review state when prior overlaps are ambiguous", () => {
    const currentFinding = finding(
      `${"The actionable issue is concise. ".repeat(40)}\n\nThis paragraph is not published.`,
      "range-1",
      10,
    );
    const publishing = buildCommentPublishingPlan({
      event,
      main: "Review completed.",
      validated: { ...validated, validFindings: [currentFinding] },
      manifest,
      priorReviewState: ambiguousPriorState(),
      metadata: metadata({ validFindings: 1 }),
    });

    const draft = publishing.inlineCommentDrafts[0];
    if (!draft) {
      throw new Error("test fixture missing inline draft");
    }

    expect(publishing.publicationPlan.reviewState.findings).toContainEqual(
      expect.objectContaining({ id: draft.findingId, lastSeenHeadSha: "head" }),
    );
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

function ambiguousPriorState(): PriorReviewState {
  return {
    version: 1,
    reviewedHeadSha: "old-head",
    selectedTasks: ["review"],
    findings: [priorFindingRecord("fnd_prior_a"), priorFindingRecord("fnd_prior_b")],
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
