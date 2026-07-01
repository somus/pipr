import { describe, expect, it } from "bun:test";
import {
  githubReviewCommentLocationSchema,
  mapFindingToGithubReviewCommentLocation,
} from "../../hosts/github/inline.js";
import type { CommentableRange, ReviewFinding } from "../../types.js";

const finding: ReviewFinding = {
  body: "This can fail.",
  path: "src/a.ts",
  rangeId: "rng_abcd1234_h1_RIGHT_10_12_deadbeefcafe",
  side: "RIGHT",
  startLine: 10,
  endLine: 12,
};

const range: CommentableRange = {
  id: finding.rangeId,
  path: finding.path,
  side: "RIGHT",
  startLine: 9,
  endLine: 12,
  kind: "mixed",
  hunkIndex: 1,
  hunkHeader: "@@ -9,4 +9,4 @@",
  hunkContentHash: "deadbeefcafe",
};

describe("GitHub review comment mapping", () => {
  it("maps multi-line findings to current GitHub line fields", () => {
    expect(
      mapFindingToGithubReviewCommentLocation({
        finding,
        range,
        headSha: "head123",
      }),
    ).toEqual({
      path: "src/a.ts",
      commit_id: "head123",
      line: 12,
      side: "RIGHT",
      start_line: 10,
      start_side: "RIGHT",
    });
  });

  it("omits start fields for single-line findings", () => {
    expect(
      mapFindingToGithubReviewCommentLocation({
        finding: { ...finding, startLine: 12 },
        range,
        headSha: "head123",
      }),
    ).toEqual({
      path: "src/a.ts",
      commit_id: "head123",
      line: 12,
      side: "RIGHT",
    });
  });

  it("maps left-side multi-line findings", () => {
    const leftFinding: ReviewFinding = {
      ...finding,
      rangeId: "rng_abcd1234_h1_LEFT_3_4_deadbeefcafe",
      side: "LEFT",
      startLine: 3,
      endLine: 4,
    };
    const leftRange: CommentableRange = {
      ...range,
      id: leftFinding.rangeId,
      side: "LEFT",
      startLine: 3,
      endLine: 4,
      kind: "deleted",
    };

    expect(
      mapFindingToGithubReviewCommentLocation({
        finding: leftFinding,
        range: leftRange,
        headSha: "head123",
      }),
    ).toEqual({
      path: "src/a.ts",
      commit_id: "head123",
      line: 4,
      side: "LEFT",
      start_line: 3,
      start_side: "LEFT",
    });
  });

  it("rejects findings outside the supplied range", () => {
    expect(() =>
      mapFindingToGithubReviewCommentLocation({
        finding: { ...finding, endLine: 13 },
        range,
        headSha: "head123",
      }),
    ).toThrow("finding lines fall outside the commentable range");
  });

  it("rejects malformed multi-line GitHub locations", () => {
    const baseLocation = {
      path: "src/a.ts",
      commit_id: "head123",
      line: 12,
      side: "RIGHT",
    };

    expect(() =>
      githubReviewCommentLocationSchema.parse({
        ...baseLocation,
        start_line: 10,
      }),
    ).toThrow("start_line and start_side together");
    expect(() =>
      githubReviewCommentLocationSchema.parse({
        ...baseLocation,
        start_side: "RIGHT",
      }),
    ).toThrow("start_line and start_side together");
    expect(() =>
      githubReviewCommentLocationSchema.parse({
        ...baseLocation,
        start_line: 13,
        start_side: "RIGHT",
      }),
    ).toThrow("start_line must be before or equal to line");
  });

  it("matches the golden GitHub inline payload locations", async () => {
    const expected = (await readJsonFixture(
      "fixtures/github-inline-payloads.golden.json",
    )) as Array<ReturnType<typeof mapFindingToGithubReviewCommentLocation>>;

    expect([
      mapFindingToGithubReviewCommentLocation({
        finding,
        range,
        headSha: "head123",
      }),
      mapFindingToGithubReviewCommentLocation({
        finding: { ...finding, startLine: 12 },
        range,
        headSha: "head123",
      }),
    ]).toEqual(expected);
  });
});

async function readJsonFixture(relativePath: string): Promise<unknown> {
  const contents = await Bun.file(new URL(relativePath, import.meta.url)).text();
  return JSON.parse(contents);
}
