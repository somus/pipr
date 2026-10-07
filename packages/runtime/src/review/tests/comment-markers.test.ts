import { describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { PriorFindingRecord, PriorReviewState } from "../../publication/types.js";
import { extractPriorReviewState, renderMainCommentMarker } from "../comment-markers.js";

const state: PriorReviewState = {
  version: 2,
  reviewedHeadSha: "head",
  selectedTasks: ["security", "review"],
  findings: [],
};

const marker = renderMainCommentMarker({
  marker: "pipr:main-comment",
  changeNumber: 7,
  reviewState: state,
});

/** Smallest host comment limit (Bitbucket Data Center) minus room for the rendered review. */
const encodedStateBudget = 24_000;

describe("main comment marker", () => {
  it("reads state only from a first-line marker for the same change", () => {
    expect(extractPriorReviewState(`${marker}\n\nSummary.`, 7)).toEqual(state);
    expect(extractPriorReviewState(`\n\n${marker}\nSummary.`, 7)).toEqual(state);
    expect(extractPriorReviewState(`${marker}\nSummary.`, 8)).toBeUndefined();
    expect(extractPriorReviewState(`Summary.\n${marker}`, 7)).toBeUndefined();
    expect(extractPriorReviewState(`${marker}\n`, 7, "pipr:other-comment")).toBeUndefined();
  });

  it("treats version 1 review state as absent", () => {
    const v1 = Buffer.from(
      JSON.stringify({
        version: 1,
        reviewedHeadSha: "head",
        selectedTasks: ["review"],
        findings: [record(0)].map(({ h: _h, a: _a, m: _m, f: _f, ...rest }) => rest),
      }),
    ).toString("base64url");
    const body = `<!-- pipr:main-comment change=7 version=1 state=${v1} -->\n\nSummary.`;

    expect(extractPriorReviewState(body, 7)).toBeUndefined();
  });

  it("round-trips per-finding facets, agent, model, and outcome history", () => {
    const stored = { ...state, findings: [record(0)] };
    const body = renderMainCommentMarker({
      marker: "pipr:main-comment",
      changeNumber: 7,
      reviewState: stored,
    });

    expect(extractPriorReviewState(body, 7)).toEqual(stored);
  });

  it("keeps 100 findings with long paths and full history within the comment budget", () => {
    const stored = { ...state, findings: Array.from({ length: 100 }, (_, index) => record(index)) };
    const body = renderMainCommentMarker({
      marker: "pipr:main-comment",
      changeNumber: 7,
      reviewState: stored,
      maxStoredFindings: 100,
    });

    expect(encodedState(body).length).toBeLessThanOrEqual(encodedStateBudget);
    const decoded = extractPriorReviewState(body, 7);
    expect(decoded?.findings.length).toBeGreaterThan(0);
    expect(decoded?.findings.map((finding) => finding.id)).toEqual(
      stored.findings.slice(0, decoded?.findings.length).map((finding) => finding.id),
    );
  });

  it("trims oldest history first, keeping fixed and human resolutions longest", () => {
    const findings = Array.from({ length: 70 }, (_, index) => record(index));
    const body = renderMainCommentMarker({
      marker: "pipr:main-comment",
      changeNumber: 7,
      reviewState: { ...state, findings },
      maxStoredFindings: 100,
    });
    const decoded = extractPriorReviewState(body, 7);

    expect(decoded?.findings.map((finding) => finding.id)).toEqual(
      findings.map((finding) => finding.id),
    );
    const history = decoded?.findings[0]?.h ?? [];
    expect(history.length).toBeLessThan(6);
    expect(history).toEqual(keepNewestPreferringSticky(findings[0]?.h ?? [], history.length));
    expect(history.map(([code]) => code)).toContain("f");
    expect(history.map(([code]) => code)).toContain("h");
  });

  it("drops resolved and historical findings before open findings of the reviewed head", () => {
    const findings = Array.from({ length: 100 }, (_, index) =>
      withoutHistory({
        ...record(index),
        ...(index % 2 === 1
          ? { status: "resolved" as const }
          : index % 3 === 0
            ? {}
            : { lastSeenHeadSha: "older-head" }),
      }),
    );
    const body = renderMainCommentMarker({
      marker: "pipr:main-comment",
      changeNumber: 7,
      reviewState: { ...state, findings },
      maxStoredFindings: 100,
    });
    const decoded = extractPriorReviewState(body, 7);
    const keptIds = new Set(decoded?.findings.map((finding) => finding.id));
    const currentOpen = findings.filter(
      (finding) => finding.status === "open" && finding.lastSeenHeadSha === "head",
    );

    expect(keptIds.size).toBeLessThan(100);
    expect(currentOpen.every((finding) => keptIds.has(finding.id))).toBe(true);
    const droppedOthers = findings.filter(
      (finding) => !keptIds.has(finding.id) && !currentOpen.includes(finding),
    );
    const keptOthers = findings.filter(
      (finding) => keptIds.has(finding.id) && !currentOpen.includes(finding),
    );
    expect(Math.min(...droppedOthers.map((finding) => findings.indexOf(finding)))).toBeGreaterThan(
      Math.max(-1, ...keptOthers.map((finding) => findings.indexOf(finding))),
    );
  });
});

/** A stored finding with incompressible hashes, a long unique path, and a full history. */
function record(index: number): PriorFindingRecord {
  const hash = (seed: string) => createHash("sha256").update(`${seed}:${index}`).digest("hex");
  return {
    id: `fnd_${hash("id").slice(0, 16)}`,
    anchorFingerprint: hash("anchor"),
    issueFingerprint: hash("issue"),
    status: "open",
    path: `packages/${hash("dir").slice(0, 24)}/src/deeply/nested/${hash("module").slice(0, 32)}/implementation-file-${index}.ts`,
    rangeId: `range-${hash("range").slice(0, 20)}`,
    side: "RIGHT",
    startLine: 100 + index,
    endLine: 120 + index,
    firstSeenHeadSha: hash("first").slice(0, 40),
    lastSeenHeadSha: "head",
    lastCommentedHeadSha: hash("commented").slice(0, 40),
    f: { severity: "high", category: "correctness" },
    a: "security-reviewer",
    m: "deepseek/deepseek-reasoner",
    h: (["f", "p", "c", "h", "s", "r"] as const).map((code) => [
      code,
      hash(`history-${code}`).slice(0, 12),
    ]),
  };
}

function withoutHistory(finding: PriorFindingRecord): PriorFindingRecord {
  const { h: _h, ...rest } = finding;
  return rest;
}

/** Expected history after dropping the oldest non-sticky entries down to `length`. */
function keepNewestPreferringSticky(
  history: NonNullable<PriorFindingRecord["h"]>,
  length: number,
): NonNullable<PriorFindingRecord["h"]> {
  const next = [...history];
  while (next.length > length) {
    const index = next.findIndex(([code]) => code !== "f" && code !== "h");
    next.splice(index === -1 ? 0 : index, 1);
  }
  return next;
}

function encodedState(body: string): string {
  return /state=(?<state>[A-Za-z0-9_-]+)/.exec(body)?.groups?.state ?? "";
}
