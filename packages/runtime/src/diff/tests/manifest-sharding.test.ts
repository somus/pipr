import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { DiffManifest, DiffManifestFile } from "../../types.js";
import { shardDiffManifestForPrompt } from "../manifest-sharding.js";

describe("Diff Manifest sharding", () => {
  it("does not load structural analysis when the fallback already fits one shard", async () => {
    const manifest = reviewTestManifest();
    let analysisCalls = 0;

    const shards = await shardDiffManifestForPrompt({
      manifest,
      config: shardConfig(4, 100_000),
      workspace: process.cwd(),
      structuralAnalysis: async () => {
        analysisCalls += 1;
        return {
          available: false,
          reason: "missing-executable",
          diagnostics: { durationMs: 0, fileCount: 0, declarationCount: 0 },
        };
      },
    });

    expect(shards).toEqual([manifest]);
    expect(analysisCalls).toBe(0);
  });

  it("preserves an individually oversized range in one complete manifest", async () => {
    const manifest = reviewTestManifest();
    const oversizedRangeId = `range-${"x".repeat(2_048)}`;
    const file = requiredFile(manifest);
    const range = file.commentableRanges[0];
    if (!range) {
      throw new Error("expected a commentable range");
    }
    const oversizedManifest = {
      ...manifest,
      files: [
        {
          ...file,
          commentableRanges: [{ ...range, id: oversizedRangeId }],
        },
      ],
    };

    const shards = await shardDiffManifestForPrompt({
      manifest: oversizedManifest,
      config: shardConfig(4, 512),
      workspace: process.cwd(),
      env: { ...process.env, PATH: "" },
    });

    expect(shards).toEqual([oversizedManifest]);
    expect(shards[0]?.files[0]?.commentableRanges[0]?.id).toBe(oversizedRangeId);
  });

  it("preserves files without hunks", async () => {
    const manifest = reviewTestManifest();
    const file = requiredFile(manifest);
    const emptyHunkFiles = Array.from({ length: 3 }, (_, index) => ({
      ...file,
      path: `src/empty-${index}.ts`,
      hunks: [],
      commentableRanges: [],
    }));
    const emptyHunkManifest = { ...manifest, files: emptyHunkFiles };

    const shards = await shardDiffManifestForPrompt({
      manifest: emptyHunkManifest,
      config: shardConfig(2, 512),
      workspace: process.cwd(),
      env: { ...process.env, PATH: "" },
    });

    expect(shards.length).toBeLessThanOrEqual(2);
    expect(shards.flatMap((shard) => shard.files.map((entry) => entry.path)).sort()).toEqual(
      emptyHunkFiles.map((entry) => entry.path).sort(),
    );
    expect(shards.flatMap((shard) => shard.files).every((entry) => entry.hunks.length === 0)).toBe(
      true,
    );
  });

  it("places a changed importer with its changed dependency before unrelated files", async () => {
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      const manifest = relatedFileManifest();
      await writeFakeAstGrepOutline(executableDirectory, [
        {
          path: "src/importer.ts",
          language: "TypeScript",
          items: [
            {
              role: "item",
              symbolType: "module",
              name: "./dependency",
              range: outlineRange(),
              isImport: true,
              isExported: false,
            },
          ],
        },
        { path: "src/unrelated.ts", language: "TypeScript", items: [] },
        { path: "src/dependency.ts", language: "TypeScript", items: [] },
      ]);

      const shards = await shardDiffManifestForPrompt({
        manifest,
        config: shardConfig(4, 2_500),
        workspace: process.cwd(),
        env: {
          ...process.env,
          PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
        },
      });

      expect(shards.map((shard) => shard.files.map((entry) => entry.path))).toEqual([
        ["src/importer.ts", "src/dependency.ts"],
        ["src/unrelated.ts"],
      ]);
    } finally {
      await rm(executableDirectory, { recursive: true, force: true });
    }
  });

  it("merges capped slices of the same path without losing hunks or ranges", async () => {
    const manifest = manyHunkSingleFileManifest();

    const shards = await shardDiffManifestForPrompt({
      manifest,
      config: shardConfig(2, 900),
      workspace: process.cwd(),
      env: { ...process.env, PATH: "" },
    });

    expect(shards).toHaveLength(2);
    expect(shards.every((shard) => shard.files.length === 1)).toBe(true);
    expect(
      shards
        .flatMap((shard) => shard.files[0]?.hunks ?? [])
        .map((hunk) => hunk.contentHash)
        .sort(),
    ).toEqual(
      requiredFile(manifest)
        .hunks.map((hunk) => hunk.contentHash)
        .sort(),
    );
    expect(
      shards
        .flatMap((shard) => shard.files[0]?.commentableRanges ?? [])
        .map((range) => range.id)
        .sort(),
    ).toEqual(
      requiredFile(manifest)
        .commentableRanges.map((range) => range.id)
        .sort(),
    );
  });

  it("preserves the exact fallback shards when structural analysis is unavailable", async () => {
    const manifest = manyHunkSingleFileManifest();
    const config = shardConfig(2, 900);
    const diagnostics = { durationMs: 0, fileCount: 0, declarationCount: 0 };

    const unavailable = await shardDiffManifestForPrompt({
      manifest,
      config,
      workspace: process.cwd(),
      structuralAnalysis: async () => ({
        available: false,
        reason: "missing-executable",
        diagnostics,
      }),
    });
    const availableWithoutRelationships = await shardDiffManifestForPrompt({
      manifest,
      config,
      workspace: process.cwd(),
      structuralAnalysis: async () => ({
        available: true,
        version: "0.44.1",
        headFiles: [],
        baseFiles: [],
        diagnostics,
      }),
    });

    expect(JSON.stringify(unavailable)).toBe(JSON.stringify(availableWithoutRelationships));
  });

  it("keeps hunks owned by the same declaration in one partition unit", async () => {
    const manifest = declarationGroupingManifest();
    const shards = await shardDiffManifestForPrompt({
      manifest,
      config: shardConfig(4, 1_500),
      workspace: process.cwd(),
      structuralAnalysis: declarationGroupingAnalysis,
    });

    expect(
      shards.map((shard) =>
        shard.files.flatMap((file) => file.hunks.map((hunk) => hunk.hunkIndex)),
      ),
    ).toEqual([[1, 2], [3]]);
    expectExactCoverage(manifest, shards);
  });

  it("groups replacement hunks owned by the same declaration across base and head", async () => {
    const manifest = mixedSideDeclarationGroupingManifest();
    const shards = await shardDiffManifestForPrompt({
      manifest,
      config: shardConfig(4, 2_200),
      workspace: process.cwd(),
      structuralAnalysis: mixedSideDeclarationGroupingAnalysis,
    });

    expect(
      shards.map((shard) =>
        shard.files.flatMap((file) => file.hunks.map((hunk) => hunk.hunkIndex)),
      ),
    ).toEqual([[1, 2], [3]]);
    expectExactCoverage(manifest, shards);
  });

  it("falls back to hunk splitting when a declaration unit is oversized", async () => {
    const manifest = declarationGroupingManifest();
    const shards = await shardDiffManifestForPrompt({
      manifest,
      config: shardConfig(4, 900),
      workspace: process.cwd(),
      structuralAnalysis: declarationGroupingAnalysis,
    });

    expect(
      shards.map((shard) =>
        shard.files.flatMap((file) => file.hunks.map((hunk) => hunk.hunkIndex)),
      ),
    ).toEqual([[1], [2], [3]]);
    expectExactCoverage(manifest, shards);
  });
});

function shardConfig(maxShards: number, condensedMaxBytes: number) {
  return {
    maxShards,
    fullMaxBytes: 1,
    fullMaxEstimatedTokens: 1,
    condensedMaxBytes,
    condensedMaxEstimatedTokens: 10_000,
  };
}

function outlineRange() {
  return {
    start: { line: 0, column: 0 },
    end: { line: 0, column: 1 },
  };
}

function requiredFile(manifest: DiffManifest): DiffManifestFile {
  const file = manifest.files[0];
  if (!file) {
    throw new Error("expected a changed file");
  }
  return file;
}

function expectExactCoverage(manifest: DiffManifest, shards: readonly DiffManifest[]): void {
  const expectedFiles = manifest.files.flatMap((file) =>
    file.hunks.map((hunk) => `${file.path}:${hunk.hunkIndex}:${hunk.contentHash}`),
  );
  const actualFiles = shards.flatMap((shard) =>
    shard.files.flatMap((file) =>
      file.hunks.map((hunk) => `${file.path}:${hunk.hunkIndex}:${hunk.contentHash}`),
    ),
  );
  const expectedRanges = manifest.files.flatMap((file) =>
    file.commentableRanges.map((range) =>
      JSON.stringify({
        path: file.path,
        id: range.id,
        side: range.side,
        startLine: range.startLine,
        endLine: range.endLine,
        hunkIndex: range.hunkIndex,
      }),
    ),
  );
  const actualRanges = shards.flatMap((shard) =>
    shard.files.flatMap((file) =>
      file.commentableRanges.map((range) =>
        JSON.stringify({
          path: file.path,
          id: range.id,
          side: range.side,
          startLine: range.startLine,
          endLine: range.endLine,
          hunkIndex: range.hunkIndex,
        }),
      ),
    ),
  );

  expect(actualFiles.sort()).toEqual(expectedFiles.sort());
  expect(actualRanges.sort()).toEqual(expectedRanges.sort());
}

function relatedFileManifest(): DiffManifest {
  const manifest = reviewTestManifest();
  const file = requiredFile(manifest);
  return {
    ...manifest,
    files: ["src/importer.ts", "src/unrelated.ts", "src/dependency.ts"].map((filePath, index) => {
      const contentHash = index.toString(16).padStart(12, "0");
      return {
        ...file,
        path: filePath,
        hunks: file.hunks.map((hunk) => ({ ...hunk, contentHash })),
        commentableRanges: file.commentableRanges.map((range, rangeIndex) => ({
          ...range,
          id: `range-${index}-${rangeIndex}`,
          path: filePath,
          hunkContentHash: contentHash,
        })),
      };
    }),
  };
}

async function writeFakeAstGrepOutline(directory: string, output: unknown): Promise<void> {
  const executable = path.join(directory, "ast-grep");
  await Bun.write(
    executable,
    [
      "#!/usr/bin/env bun",
      'if (process.argv.includes("--version")) {',
      '  process.stdout.write("ast-grep 0.44.1\\n");',
      "} else {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(output))});`,
      "}",
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
}

function manyHunkSingleFileManifest(): DiffManifest {
  const manifest = reviewTestManifest();
  const file = requiredFile(manifest);
  return {
    ...manifest,
    files: [
      {
        ...file,
        hunks: Array.from({ length: 8 }, (_, index) => {
          const line = index + 1;
          return {
            hunkIndex: line,
            header: `@@ -${line},1 +${line},1 @@`,
            oldStart: line,
            oldLines: 1,
            newStart: line,
            newLines: 1,
            contentHash: index.toString(16).padStart(12, "0"),
          };
        }),
        commentableRanges: Array.from({ length: 8 }, (_, index) => {
          const line = index + 1;
          return {
            id: `single-range-${index}`,
            path: file.path,
            side: "RIGHT" as const,
            startLine: line,
            endLine: line,
            kind: "added" as const,
            hunkIndex: line,
            hunkHeader: `@@ -${line},1 +${line},1 @@`,
            hunkContentHash: index.toString(16).padStart(12, "0"),
            preview: `changed line ${line}`,
          };
        }),
      },
    ],
  };
}

function declarationGroupingManifest(): DiffManifest {
  const manifest = manyHunkSingleFileManifest();
  const file = requiredFile(manifest);
  const selectedHunks = file.hunks.slice(0, 3).map((hunk, index) => {
    const line = index === 2 ? 20 : index * 10 + 1;
    return {
      ...hunk,
      hunkIndex: index + 1,
      header: `@@ -${line},1 +${line},1 @@`,
      oldStart: line,
      newStart: line,
    };
  });
  const [firstRange, secondRange, thirdRange] = file.commentableRanges;
  if (!firstRange || !secondRange || !thirdRange) {
    throw new Error("expected three commentable ranges");
  }
  const selectedRanges = [firstRange, secondRange, thirdRange];
  return {
    ...manifest,
    files: [
      {
        ...file,
        hunks: selectedHunks,
        commentableRanges: selectedHunks.map((hunk, index) => ({
          ...selectedRanges[index],
          id: `declaration-range-${index}`,
          startLine: hunk.newStart,
          endLine: hunk.newStart,
          hunkIndex: hunk.hunkIndex,
          hunkHeader: hunk.header,
          hunkContentHash: hunk.contentHash,
        })),
      },
    ],
  };
}

function mixedSideDeclarationGroupingManifest(): DiffManifest {
  const manifest = declarationGroupingManifest();
  const file = requiredFile(manifest);
  const baseLines = [3, 13, 22];
  return {
    ...manifest,
    files: [
      {
        ...file,
        commentableRanges: file.commentableRanges.flatMap((range, index) => [
          {
            ...range,
            id: `${range.id}-left`,
            side: "LEFT" as const,
            startLine: baseLines[index] ?? range.startLine,
            endLine: baseLines[index] ?? range.endLine,
            kind: "deleted" as const,
          },
          range,
        ]),
      },
    ],
  };
}

async function declarationGroupingAnalysis() {
  return {
    available: true as const,
    version: "0.44.1",
    headFiles: [
      {
        path: "src/a.ts",
        language: "TypeScript",
        imports: [],
        declarations: [
          {
            qualifiedName: "shared",
            kind: "function",
            startLine: 1,
            endLine: 12,
            isExported: false,
          },
          {
            qualifiedName: "separate",
            kind: "function",
            startLine: 20,
            endLine: 24,
            isExported: false,
          },
        ],
      },
    ],
    baseFiles: [],
    diagnostics: { durationMs: 1, fileCount: 1, declarationCount: 2 },
  };
}

async function mixedSideDeclarationGroupingAnalysis() {
  const analysis = await declarationGroupingAnalysis();
  return {
    ...analysis,
    baseFiles: [
      {
        path: "src/a.ts",
        language: "TypeScript",
        imports: [],
        declarations: [
          {
            qualifiedName: "shared",
            kind: "function",
            startLine: 3,
            endLine: 14,
            isExported: false,
          },
          {
            qualifiedName: "separate",
            kind: "function",
            startLine: 22,
            endLine: 26,
            isExported: false,
          },
        ],
      },
    ],
    diagnostics: { durationMs: 1, fileCount: 2, declarationCount: 4 },
  };
}
