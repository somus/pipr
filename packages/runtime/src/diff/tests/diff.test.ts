import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeAggregateReviewablePatchOver16MiB } from "../../tests/helpers/aggregate-reviewable-patch.js";
import { buildDiffManifest } from "../diff.js";
import { runGit } from "../git.js";

describe("diff manifest parsing", () => {
  it("keeps hunk 1 range ids stable when only hunk 2 changes", async () => {
    await withGitRepo(async (repo) => {
      const lines = makeNumberedLines("line", 400).split("\n");
      const baseSha = await commitFile(repo, "src/a.ts", lines.join("\n"), "base");
      const edit = (secondHunk: string) =>
        lines
          .map((line, index) => {
            if (index === 5) {
              return "first hunk edit";
            }
            return index === 350 ? secondHunk : line;
          })
          .join("\n");
      const firstHead = await commitFile(repo, "src/a.ts", edit("second hunk v1"), "head v1");
      git(repo, "reset", "--hard", baseSha);
      const secondHead = await commitFile(repo, "src/a.ts", edit("second hunk v2"), "head v2");

      const rangesFor = (headSha: string) =>
        changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "src/a.ts")
          ?.commentableRanges ?? [];
      const first = rangesFor(firstHead);
      const second = rangesFor(secondHead);
      const idsForHunk = (ranges: typeof first, hunkIndex: number) =>
        ranges.filter((range) => range.hunkIndex === hunkIndex).map((range) => range.id);

      expect(idsForHunk(first, 1)).toHaveLength(2);
      expect(idsForHunk(second, 1)).toEqual(idsForHunk(first, 1));
      expect(idsForHunk(second, 2)).toHaveLength(2);
      expect(idsForHunk(second, 2)).not.toEqual(idsForHunk(first, 2));
    });
  });

  it("runs git with the injected environment, not the process environment", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "a.txt", "one\n", "base");
      const headSha = await commitFile(repo, "a.txt", "two\n", "head");
      const env = { ...process.env, GIT_DIR: path.join(repo, "missing-git-dir") };

      expect(() => buildDiffManifest({ cwd: repo, baseSha, headSha, env })).toThrow(
        "git merge-base",
      );
    });
  });

  it("parses a Markdown --- removal from a real git diff without shifting lines", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(
        repo,
        "doc.md",
        "# Title\n---\n++counter\nbody\nold\n",
        "base",
      );
      const headSha = await commitFile(repo, "doc.md", "# Title\n++i;\nbody\nnew\n", "head");

      const file = changedFile(buildDiffManifest({ cwd: repo, baseSha, headSha }), "doc.md");

      expect(
        file?.commentableRanges.map(({ side, startLine, endLine, preview }) => ({
          side,
          startLine,
          endLine,
          preview,
        })),
      ).toEqual([
        { side: "LEFT", startLine: 2, endLine: 3, preview: "---\n++counter" },
        { side: "RIGHT", startLine: 2, endLine: 2, preview: "++i;" },
        { side: "LEFT", startLine: 5, endLine: 5, preview: "old" },
        { side: "RIGHT", startLine: 4, endLine: 4, preview: "new" },
      ]);
    });
  });

  describe("real git edge cases", () => {
    type EdgeCase = {
      name: string;
      setup?: (repo: string) => void;
      base: Record<string, string>;
      head: (repo: string) => Promise<void>;
      expected: Array<Record<string, unknown>>;
    };
    const rangeSummary = (file: ReturnType<typeof changedFile>) =>
      file?.commentableRanges.map(({ side, startLine, endLine, preview }) => ({
        side,
        startLine,
        endLine,
        preview,
      }));
    const edgeCases: EdgeCase[] = [
      {
        name: "CRLF line endings",
        base: { "crlf.txt": "one\r\ntwo\r\nthree\r\n" },
        head: async (repo) => {
          await Bun.write(path.join(repo, "crlf.txt"), "one\r\nTWO\r\nthree\r\n");
        },
        expected: [
          {
            path: "crlf.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
            ranges: [
              { side: "LEFT", startLine: 2, endLine: 2, preview: "two\r" },
              { side: "RIGHT", startLine: 2, endLine: 2, preview: "TWO\r" },
            ],
          },
        ],
      },
      {
        name: "no newline at end of file between - and +",
        base: { "eof.txt": "one\ntwo" },
        head: async (repo) => {
          await Bun.write(path.join(repo, "eof.txt"), "one\nTWO");
        },
        expected: [
          {
            path: "eof.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
            ranges: [
              { side: "LEFT", startLine: 2, endLine: 2, preview: "two" },
              { side: "RIGHT", startLine: 2, endLine: 2, preview: "TWO" },
            ],
          },
        ],
      },
      {
        name: "mode-only change",
        base: { "script.sh": "echo hi\n" },
        head: async (repo) => {
          await chmod(path.join(repo, "script.sh"), 0o755);
        },
        expected: [
          {
            path: "script.sh",
            status: "modified",
            additions: 0,
            deletions: 0,
            hunks: 0,
            ranges: [],
          },
        ],
      },
      {
        name: "copy with copy detection configured",
        setup: (repo) => git(repo, "config", "diff.renames", "copies"),
        base: { "orig.txt": "one\ntwo\nthree\nfour\nfive\n" },
        head: async (repo) => {
          await Bun.write(path.join(repo, "copy.txt"), "one\ntwo\nthree\nfour\nfive\n");
          await Bun.write(path.join(repo, "orig.txt"), "one\ntwo\nthree\nfour\nfive\nsix\n");
        },
        expected: [
          {
            path: "copy.txt",
            status: "added",
            additions: 5,
            deletions: 0,
            ranges: [
              {
                side: "RIGHT",
                startLine: 1,
                endLine: 5,
                preview: "one\ntwo\nthree\nfour\nfive",
              },
            ],
          },
          {
            path: "orig.txt",
            status: "modified",
            additions: 1,
            deletions: 0,
            ranges: [{ side: "RIGHT", startLine: 6, endLine: 6, preview: "six" }],
          },
        ],
      },
      {
        name: "type change followed by another file",
        base: { "link.txt": "one\ntwo\n", "z-after.txt": "before\n" },
        head: async (repo) => {
          await rm(path.join(repo, "link.txt"));
          await symlink("z-after.txt", path.join(repo, "link.txt"));
          await Bun.write(path.join(repo, "z-after.txt"), "after\n");
        },
        expected: [
          {
            path: "link.txt",
            status: "modified",
            ranges: [
              { side: "LEFT", startLine: 1, endLine: 2, preview: "one\ntwo" },
              { side: "RIGHT", startLine: 1, endLine: 1, preview: "z-after.txt" },
            ],
          },
          {
            path: "z-after.txt",
            status: "modified",
            additions: 1,
            deletions: 1,
            ranges: [
              { side: "LEFT", startLine: 1, endLine: 1, preview: "before" },
              { side: "RIGHT", startLine: 1, endLine: 1, preview: "after" },
            ],
          },
        ],
      },
      {
        name: "added and deleted files",
        base: { "gone.txt": "bye\n" },
        head: async (repo) => {
          await rm(path.join(repo, "gone.txt"));
          await Bun.write(path.join(repo, "new.txt"), "hello\nworld\n");
        },
        expected: [
          {
            path: "gone.txt",
            status: "removed",
            excludedReason: "removed file",
            hunks: 0,
            ranges: [],
          },
          {
            path: "new.txt",
            status: "added",
            additions: 2,
            deletions: 0,
            ranges: [{ side: "RIGHT", startLine: 1, endLine: 2, preview: "hello\nworld" }],
          },
        ],
      },
      {
        name: "rename with edits",
        base: { "old.txt": "one\ntwo\nthree\nfour\nfive\nsix\n" },
        head: async (repo) => {
          await rm(path.join(repo, "old.txt"));
          await Bun.write(path.join(repo, "renamed.txt"), "one\ntwo\nTHREE\nfour\nfive\nsix\n");
        },
        expected: [
          {
            path: "renamed.txt",
            previousPath: "old.txt",
            status: "renamed",
            additions: 1,
            deletions: 1,
            ranges: [
              { side: "LEFT", startLine: 3, endLine: 3, preview: "three" },
              { side: "RIGHT", startLine: 3, endLine: 3, preview: "THREE" },
            ],
          },
        ],
      },
    ];

    for (const edgeCase of edgeCases) {
      it(edgeCase.name, async () => {
        await withGitRepo(async (repo) => {
          edgeCase.setup?.(repo);
          for (const [filePath, contents] of Object.entries(edgeCase.base)) {
            await Bun.write(path.join(repo, filePath), contents);
          }
          commitAll(repo, "base");
          const baseSha = git(repo, "rev-parse", "HEAD");
          await edgeCase.head(repo);
          commitAll(repo, "head");
          const headSha = git(repo, "rev-parse", "HEAD");

          const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

          expect(
            manifest.files.map((file) => {
              const summary: Record<string, unknown> = {
                path: file.path,
                status: file.status,
                ranges: rangeSummary(file),
              };
              for (const key of Object.keys(
                edgeCase.expected.find((entry) => entry.path === file.path) ?? {},
              )) {
                if (key === "hunks") {
                  summary.hunks = file.hunks.length;
                } else if (key !== "ranges" && key in file) {
                  summary[key] = file[key as keyof typeof file];
                }
              }
              return summary;
            }),
          ).toEqual(edgeCase.expected);
        });
      });
    }
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

  it("rejects aggregate reviewable patch output above 16 MiB before parsing", async () => {
    await withGitRepo(async (repo) => {
      const baseSha = await commitFile(repo, "seed.txt", "base\n", "base");
      await writeAggregateReviewablePatchOver16MiB(repo);
      commitAll(repo, "aggregate patch");
      const headSha = git(repo, "rev-parse", "HEAD");

      expect(() => buildDiffManifest({ cwd: repo, baseSha, headSha })).toThrow(
        "Diff Manifest construction exceeded aggregate patch limit before parsing; limit=16777216 bytes",
      );
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

  it("excludes removed, lock, and generated files before generating patch content", async () => {
    await withGitRepo(async (repo) => {
      await mkdir(path.join(repo, "src"), { recursive: true });
      await mkdir(path.join(repo, "dist"), { recursive: true });
      await Bun.write(
        path.join(repo, ".gitattributes"),
        `${[
          "src/deleted.ts diff=pipr-excluded",
          "bun.lock diff=pipr-excluded",
          "dist/out.js diff=pipr-excluded",
        ].join("\n")}\n`,
      );
      git(repo, "config", "diff.pipr-excluded.textconv", "false");
      await Bun.write(path.join(repo, "src/deleted.ts"), "old\n");
      await Bun.write(path.join(repo, "src/included.ts"), "before\n");
      await Bun.write(path.join(repo, "bun.lock"), "lock-v1\n");
      await Bun.write(path.join(repo, "dist/out.js"), "generated-v1\n");
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rm(path.join(repo, "src/deleted.ts"));
      await Bun.write(path.join(repo, "src/included.ts"), "after\n");
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
      expect(changedFile(manifest, "src/included.ts")?.commentableRanges).toEqual(
        expect.arrayContaining([expect.objectContaining({ preview: "after" })]),
      );
    });
  });

  it("excludes both sides of a generated rename before generating an empty patch", async () => {
    await withGitRepo(async (repo) => {
      await mkdir(path.join(repo, "src"), { recursive: true });
      await mkdir(path.join(repo, "dist"), { recursive: true });
      await Bun.write(
        path.join(repo, ".gitattributes"),
        `${["src/old.ts diff=pipr-excluded", "dist/new.ts diff=pipr-excluded"].join("\n")}\n`,
      );
      git(repo, "config", "diff.pipr-excluded.textconv", "false");
      await Bun.write(path.join(repo, "src/old.ts"), makeNumberedLines("line", 20));
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rename(path.join(repo, "src/old.ts"), path.join(repo, "dist/new.ts"));
      commitAll(repo, "head");
      const headSha = git(repo, "rev-parse", "HEAD");

      expect(buildDiffManifest({ cwd: repo, baseSha, headSha }).files).toMatchObject([
        {
          path: "dist/new.ts",
          previousPath: "src/old.ts",
          status: "renamed",
          excludedReason: "generated or build output",
          hunks: [],
          commentableRanges: [],
        },
      ]);
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

  it("keeps sparse diffs whose changed lines stay below the manifest caps", async () => {
    await expectSparseDiffIncluded({ filePath: "sparse.ts", lineCount: 400 });
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

  it("preserves exact Git paths containing delimiters and rename-like text", async () => {
    await withGitRepo(async (repo) => {
      const previousPath = "src/old\tname.ts";
      const renamedPath = "src/new\nname.ts";
      const renameLikePath = "src/{before => after}.ts";
      const tabPath = "src/plain\tname.ts";
      await mkdir(path.join(repo, "src"), { recursive: true });
      await Bun.write(path.join(repo, previousPath), "one\ntwo\nthree\nfour\n");
      await Bun.write(path.join(repo, renameLikePath), "before\n");
      await Bun.write(path.join(repo, tabPath), "tab before\n");
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rename(path.join(repo, previousPath), path.join(repo, renamedPath));
      await Bun.write(path.join(repo, renamedPath), "one\ntwo\nthree\nFOUR\n");
      await Bun.write(path.join(repo, renameLikePath), "after\n");
      await Bun.write(path.join(repo, tabPath), "tab after\n");
      commitAll(repo, "head");
      const headSha = git(repo, "rev-parse", "HEAD");

      const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });

      expect({
        renamed: changedFile(manifest, renamedPath),
        renameLike: changedFile(manifest, renameLikePath),
        tab: changedFile(manifest, tabPath),
      }).toMatchObject({
        renamed: {
          path: renamedPath,
          previousPath,
          status: "renamed",
          additions: 1,
          deletions: 1,
          hunks: expect.arrayContaining([expect.any(Object)]),
          commentableRanges: expect.arrayContaining([
            expect.objectContaining({ path: renamedPath }),
          ]),
        },
        renameLike: {
          path: renameLikePath,
          status: "modified",
          additions: 1,
          deletions: 1,
          hunks: expect.arrayContaining([expect.any(Object)]),
          commentableRanges: expect.arrayContaining([
            expect.objectContaining({ path: renameLikePath }),
          ]),
        },
        tab: {
          path: tabPath,
          status: "modified",
          additions: 1,
          deletions: 1,
          hunks: expect.arrayContaining([expect.any(Object)]),
          commentableRanges: expect.arrayContaining([expect.objectContaining({ path: tabPath })]),
        },
      });
    });
  });

  it("preserves exact Git paths from working-tree diffs", async () => {
    await withGitRepo(async (repo) => {
      const previousPath = "src/old\tname.ts";
      const renamedPath = "src/new\nname.ts";
      await mkdir(path.join(repo, "src"), { recursive: true });
      await Bun.write(path.join(repo, previousPath), "one\ntwo\nthree\n");
      commitAll(repo, "base");
      const baseSha = git(repo, "rev-parse", "HEAD");

      await rename(path.join(repo, previousPath), path.join(repo, renamedPath));
      await Bun.write(path.join(repo, renamedPath), "one\ntwo\nTHREE\n");
      git(repo, "add", "-A");

      const manifest = buildDiffManifest({
        cwd: repo,
        baseSha,
        headSha: baseSha,
        includeWorkingTree: true,
      });

      expect(changedFile(manifest, renamedPath)).toMatchObject({
        path: renamedPath,
        previousPath,
        status: "renamed",
        additions: 1,
        deletions: 1,
        hunks: expect.arrayContaining([expect.any(Object)]),
        commentableRanges: expect.arrayContaining([expect.objectContaining({ path: renamedPath })]),
      });
    });
  });

  it("keeps outer-file hunks aligned when Git expands submodule diffs", async () => {
    await withGitRepo(async (repo) => {
      await withGitRepo(async (submoduleRepo) => {
        await Bun.write(path.join(submoduleRepo, "a.txt"), "a before\n");
        await Bun.write(path.join(submoduleRepo, "b.txt"), "b before\n");
        commitAll(submoduleRepo, "submodule base");

        git(repo, "-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "sub");
        await Bun.write(path.join(repo, "zouter.txt"), "outer before\n");
        commitAll(repo, "base");
        const baseSha = git(repo, "rev-parse", "HEAD");

        git(path.join(repo, "sub"), "config", "user.email", "test@example.com");
        git(path.join(repo, "sub"), "config", "user.name", "pipr test");
        await Bun.write(path.join(repo, "sub/a.txt"), "a after\n");
        await Bun.write(path.join(repo, "sub/b.txt"), "b after\n");
        commitAll(path.join(repo, "sub"), "submodule head");
        await Bun.write(path.join(repo, "zouter.txt"), "outer after\n");
        git(repo, "config", "diff.submodule", "diff");
        commitAll(repo, "head");
        const headSha = git(repo, "rev-parse", "HEAD");

        const manifest = buildDiffManifest({ cwd: repo, baseSha, headSha });
        const outerFile = changedFile(manifest, "zouter.txt");

        expect(outerFile?.hunks).toHaveLength(1);
        expect(outerFile?.commentableRanges).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ path: "zouter.txt", preview: "outer after" }),
            expect.objectContaining({ path: "zouter.txt", preview: "outer before" }),
          ]),
        );
      });
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
