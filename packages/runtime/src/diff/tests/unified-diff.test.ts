import { describe, expect, it } from "bun:test";
import { parseUnifiedDiff } from "../unified-diff.js";

describe("unified diff parsing", () => {
  it("creates same-side contiguous commentable ranges", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "+const b = 2;",
      "+const c = 3;",
      "-const old = 4;",
    ].join("\n");

    const file = parseUnifiedDiff(diff, ["src/a.ts"]).get("src/a.ts");
    const ranges = file?.commentableRanges;

    expect(ranges).toHaveLength(2);
    expect(ranges?.[0]).toMatchObject({ side: "RIGHT", startLine: 2, endLine: 3, kind: "added" });
    expect(ranges?.[1]).toMatchObject({ side: "LEFT", startLine: 2, endLine: 2 });
  });

  it("adds hunk metadata and hunk-aware deterministic range ids", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,4 @@",
      " const a = 1;",
      "+const b = 2;",
      "-const old = 4;",
      " const tail = 5;",
    ].join("\n");

    const file = parseUnifiedDiff(diff, ["src/a.ts"]).get("src/a.ts");

    expect(file?.hunks).toMatchObject([
      {
        hunkIndex: 1,
        header: "@@ -1,3 +1,4 @@",
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 4,
      },
    ]);
    expect(file?.hunks[0]?.contentHash).toMatch(/^[a-f0-9]{12}$/);
    expect(file?.commentableRanges[0]).toMatchObject({
      path: "src/a.ts",
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
      kind: "added",
      hunkIndex: 1,
      hunkContentHash: file?.hunks[0]?.contentHash,
    });
    expect(file?.commentableRanges[0]?.id).toMatch(/^rng_[a-f0-9]{8}_h1_RIGHT_2_2_[a-f0-9]{12}$/);
  });

  it("changes range ids when hunk content changes", () => {
    const baseDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
    ].join("\n");
    const changedDiff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "+const b = 3;",
    ].join("\n");

    const baseId = parseUnifiedDiff(baseDiff, ["src/a.ts"]).get("src/a.ts")?.commentableRanges[0]
      ?.id;
    const changedId = parseUnifiedDiff(changedDiff, ["src/a.ts"]).get("src/a.ts")
      ?.commentableRanges[0]?.id;

    expect(baseId).toBeDefined();
    expect(changedId).toBeDefined();
    expect(baseId).not.toBe(changedId);
  });

  it("tracks hunk indexes and range ids across multiple hunks", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "+const b = 2;",
      "@@ -20,2 +20,2 @@",
      " const c = 3;",
      "+const d = 4;",
    ].join("\n");

    const file = parseUnifiedDiff(diff, ["src/a.ts"]).get("src/a.ts");

    expect(file?.hunks.map((hunk) => hunk.hunkIndex)).toEqual([1, 2]);
    expect(file?.hunks[0]?.contentHash).not.toBe(file?.hunks[1]?.contentHash);
    expect(file?.commentableRanges.map((range) => range.hunkIndex)).toEqual([1, 2]);
    expect(file?.commentableRanges[0]?.id).toContain("_h1_RIGHT_");
    expect(file?.commentableRanges[1]?.id).toContain("_h2_RIGHT_");
    expect(file?.commentableRanges[0]?.hunkContentHash).toBe(file?.hunks[0]?.contentHash);
    expect(file?.commentableRanges[1]?.hunkContentHash).toBe(file?.hunks[1]?.contentHash);
  });

  it("defaults omitted hunk line counts to one", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");

    const hunk = parseUnifiedDiff(diff, ["src/a.ts"]).get("src/a.ts")?.hunks[0];

    expect(hunk).toMatchObject({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    });
  });

  it("treats ---/+++ lines inside an open hunk as removed/added content", () => {
    const diff = [
      "diff --git a/notes.md b/notes.md",
      "index 111..222 100644",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -1,4 +1,4 @@",
      " title",
      "----",
      "+++i;",
      " keep",
      "-old",
      "+new",
    ].join("\n");

    const file = parseUnifiedDiff(diff, ["notes.md"]).get("notes.md");

    expect(
      file?.commentableRanges.map(({ side, startLine, endLine, preview }) => ({
        side,
        startLine,
        endLine,
        preview,
      })),
    ).toEqual([
      { side: "LEFT", startLine: 2, endLine: 2, preview: "---" },
      { side: "RIGHT", startLine: 2, endLine: 2, preview: "++i;" },
      { side: "LEFT", startLine: 4, endLine: 4, preview: "old" },
      { side: "RIGHT", startLine: 4, endLine: 4, preview: "new" },
    ]);
  });
});
