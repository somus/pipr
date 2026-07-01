import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildDiffManifest, parseNameStatus, parseUnifiedDiff } from "../diff.js";
import { runGit } from "../git.js";

describe("diff manifest parsing", () => {
  it("parses name-status output", () => {
    expect(parseNameStatus("A\tsrc/a.ts\nM\tsrc/b.ts\nR100\told.ts\tnew.ts\n")).toMatchObject([
      { path: "src/a.ts", status: "added" },
      { path: "src/b.ts", status: "modified" },
      { path: "new.ts", previousPath: "old.ts", status: "renamed" },
    ]);
  });

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

    const file = parseUnifiedDiff(diff).get("src/a.ts");
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

    const file = parseUnifiedDiff(diff).get("src/a.ts");

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

    const baseId = parseUnifiedDiff(baseDiff).get("src/a.ts")?.commentableRanges[0]?.id;
    const changedId = parseUnifiedDiff(changedDiff).get("src/a.ts")?.commentableRanges[0]?.id;

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

    const file = parseUnifiedDiff(diff).get("src/a.ts");

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

    const hunk = parseUnifiedDiff(diff).get("src/a.ts")?.hunks[0];

    expect(hunk).toMatchObject({
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
    });
  });

  it("uses the merge base when the base branch has advanced", async () => {
    await withGitRepo(async (repo) => {
      await Bun.write(path.join(repo, "shared.txt"), "base\n");
      commitAll(repo, "base");
      const mergeBaseSha = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "-b", "feature");
      await Bun.write(path.join(repo, "feature.txt"), "feature\n");
      commitAll(repo, "feature");
      const headSha = git(repo, "rev-parse", "HEAD");

      git(repo, "checkout", "main");
      await Bun.write(path.join(repo, "base-only.txt"), "base only\n");
      commitAll(repo, "base advance");
      const baseSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect(manifest.mergeBaseSha).toBe(mergeBaseSha);
      expect(manifest.files).toMatchObject([
        {
          path: "feature.txt",
          additions: 1,
          deletions: 0,
          hunks: [
            expect.objectContaining({
              hunkIndex: 1,
              contentHash: expect.stringMatching(/^[a-f0-9]{12}$/),
            }),
          ],
        },
      ]);
    });
  });

  it("excludes oversized changed-line spans", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "seed.txt", "base\n", "base");
      const largeFile = Array.from(
        { length: 1200 },
        (_, index) => `line ${index} ${"x".repeat(2000)}`,
      ).join("\n");
      const headSha = await commitFile(repo, "large.ts", `${largeFile}\n`, "large file");
      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "large.ts");

      expect(file?.excludedReason).toBe("oversized diff");
      expect(file?.additions).toBe(1200);
      expect(file?.deletions).toBe(0);
      expect(file?.commentableRanges).toEqual([]);
    });
  });

  it("excludes binary diffs before parsing inline ranges", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "asset.bin", Buffer.from([0, 1, 2, 3, 4]), "base");
      const headSha = await commitFile(
        repo,
        "asset.bin",
        Buffer.from([0, 1, 2, 9, 10]),
        "binary change",
      );
      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "asset.bin");

      expect(file?.excludedReason).toBe("binary diff");
      expect(file?.additions).toBe(0);
      expect(file?.deletions).toBe(0);
      expect(file?.commentableRanges).toEqual([]);
    });
  });

  it("excludes removed, lock, and generated files from inline ranges", async () => {
    await withGitRepo(async (repo) => {
      await mkdir(path.join(repo, "src"), { recursive: true });
      await mkdir(path.join(repo, "dist"), { recursive: true });
      await Bun.write(path.join(repo, "src/deleted.ts"), "old\n");
      await Bun.write(path.join(repo, "bun.lock"), "lock-v1\n");
      await Bun.write(path.join(repo, "dist/out.js"), "generated-v1\n");
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rm(path.join(repo, "src/deleted.ts"));
      await Bun.write(path.join(repo, "bun.lock"), "lock-v2\n");
      await Bun.write(path.join(repo, "dist/out.js"), "generated-v2\n");
      commitAll(repo, "head");
      const headSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect(changedFile(manifest, "src/deleted.ts")).toMatchObject({
        status: "removed",
        excludedReason: "removed file",
        hunks: [],
        commentableRanges: [],
      });
      expect(changedFile(manifest, "bun.lock")).toMatchObject({
        excludedReason: "lock file",
        hunks: [],
        commentableRanges: [],
      });
      expect(changedFile(manifest, "dist/out.js")).toMatchObject({
        excludedReason: "generated or build output",
        hunks: [],
        commentableRanges: [],
      });
    });
  });

  it("treats pre-excluded file paths as literal git pathspecs", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "seed.txt", "base\n", "base");
      const largeFile = makeNumberedLines("large", 1200);
      await Bun.write(path.join(repo, "*"), largeFile);
      await Bun.write(path.join(repo, "normal.ts"), "const ok = true;\n");
      commitAll(repo, "head");
      const headSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect(changedFile(manifest, "*")).toMatchObject({
        excludedReason: "oversized diff",
        hunks: [],
        commentableRanges: [],
      });
      expect(changedFile(manifest, "normal.ts")?.commentableRanges.length).toBeGreaterThan(0);
    });
  });

  it("keeps sparse context diffs below the expanded manifest cap", async () => {
    await expectSparseDiffIncluded({ filePath: "sparse.ts", lineCount: 400 });
  });

  it("keeps large sparse diffs when changed lines stay below the manifest cap", async () => {
    await expectSparseDiffIncluded({ filePath: "huge-sparse.ts", lineCount: 7000 });
  });

  it("keeps additions and deletions for renamed files", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "src/old.ts", "line 1\nline 2\n", "base");

      await rm(path.join(repo, "src", "old.ts"), { force: true });
      const headSha = await commitFile(repo, "src/new.ts", "line 1\nline 2\nline 3\n", "rename");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect(manifest.files).toMatchObject([
        {
          path: "src/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          additions: 1,
          deletions: 0,
        },
      ]);
      expect(manifest.files[0]?.commentableRanges[0]?.id).toMatch(
        /^rng_[a-f0-9]{8}_h1_RIGHT_\d+_\d+_[a-f0-9]{12}$/,
      );
    });
  });

  it("matches the golden diff manifest file shape", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "src/a.ts", "one\ntwo\nthree\n", "base");
      const headSha = await commitFile(repo, "src/a.ts", "one\nTWO\nthree\nfour\n", "head");
      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });
      const expected = (await readJsonFixture("fixtures/diff-manifest.golden.json")) as Pick<
        ReturnType<typeof buildDiffManifest>,
        "files"
      >;

      expect(manifest.files).toEqual(expected.files);
    });
  });

  it("pre-excludes oversized renamed files while preserving target stats", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "src/old.ts", makeNumberedLines("base", 3000), "base");

      await rm(path.join(repo, "src", "old.ts"), { force: true });
      const headSha = await commitFile(
        repo,
        "src/new.ts",
        makePartiallyChangedLines(1200, 3000),
        "oversized rename",
      );

      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "src/new.ts");

      expect(file).toMatchObject({
        previousPath: "src/old.ts",
        status: "renamed",
        additions: 1200,
        deletions: 1200,
        excludedReason: "oversized diff",
      });
      expect(file?.commentableRanges).toEqual([]);
    });
  });
});

async function withGitRepo<T>(run: (repo: string) => Promise<T>): Promise<T> {
  const repo = await createGitRepo();
  try {
    return await run(repo);
  } finally {
    await removeTempRepo(repo);
  }
}

async function removeTempRepo(repo: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(repo, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!isRetryableRmError(error) || attempt === 4) {
        throw error;
      }
      await delay(50);
    }
  }
}

function isRetryableRmError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOTEMPTY";
}

async function createGitRepo(): Promise<string> {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pipr-diff-"));
  git(repo, "init", "-b", "main");
  git(repo, "config", "core.hooksPath", "/dev/null");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "pipr test");
  return repo;
}

function commitAll(repo: string, message: string): void {
  git(repo, "add", ".");
  git(repo, "commit", "--no-verify", "-m", message);
}

async function commitFile(
  repo: string,
  filePath: string,
  contents: string | Buffer,
  message: string,
): Promise<string> {
  const target = path.join(repo, filePath);
  await mkdir(path.dirname(target), { recursive: true });
  await Bun.write(target, contents);
  commitAll(repo, message);
  return git(repo, "rev-parse", "HEAD");
}

function changedFile(manifest: ReturnType<typeof buildDiffManifest>, filePath: string) {
  return manifest.files.find((entry) => entry.path === filePath);
}

async function expectSparseDiffIncluded(options: {
  filePath: string;
  lineCount: number;
}): Promise<void> {
  await withGitRepo(async (repo) => {
    const baseSha = await commitFile(
      repo,
      options.filePath,
      makeNumberedLines("base", options.lineCount),
      "base",
    );
    const headSha = await commitFile(
      repo,
      options.filePath,
      makeSparseChangedLines(options.lineCount),
      "head",
    );
    const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), options.filePath);

    expect(file?.excludedReason).toBeUndefined();
    expect(file?.hunks.length).toBeGreaterThan(0);
    expect(file?.commentableRanges.length).toBeGreaterThan(0);
  });
}

function git(repo: string, ...args: string[]): string {
  return runGit(args, repo).trim();
}

function makeNumberedLines(prefix: string, count: number): string {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index}`).join("\n")}\n`;
}

function makePartiallyChangedLines(changedCount: number, totalCount: number): string {
  return `${Array.from({ length: totalCount }, (_, index) =>
    index < changedCount ? `changed ${index}` : `base ${index}`,
  ).join("\n")}\n`;
}

function makeSparseChangedLines(totalCount: number): string {
  return `${Array.from({ length: totalCount }, (_, index) =>
    index % 200 === 0 ? `changed ${index}` : `base ${index}`,
  ).join("\n")}\n`;
}

async function readJsonFixture(relativePath: string): Promise<unknown> {
  const contents = await Bun.file(new URL(relativePath, import.meta.url)).text();
  return JSON.parse(contents);
}
