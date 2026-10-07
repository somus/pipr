import { describe, expect, it } from "bun:test";
import { access, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createAdvancedBaseRepo,
  createGitRepo,
  executeRuntimeTool,
  loadRuntimeTool,
  manifestForPath,
  readAtRefWithTool,
  removeTree,
  renamedManifest,
  structuralAnalysisForRenamedFile,
} from "../../tests/helpers/runtime-read-tools.js";
import { preparePiRuntimeReadTools } from "../runtime-tools.js";

describe("pipr runtime Pi read tool preparation", () => {
  it("loads runtime read tools with range-scoped base truncation metadata", async () => {
    const repo = await createGitRepo({
      baseContent: `${"base ".repeat(20)}\n`,
      headContent: `${"head ".repeat(20)}\n`,
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-extension-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: { manifest, toolResponseMaxBytes: 10 },
      });
      await access(prepared.dataPath);
      await expect(
        access(path.join(toolRoot, "runtime-tools", "pipr-runtime-tools.mjs")),
      ).rejects.toThrow();
      const atRefTool = await loadRuntimeTool(prepared.dataPath, "pipr_read_at_ref");

      const result = await executeRuntimeTool(atRefTool, repo.root, {
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-left",
      });

      expect(result).toMatchObject({
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-left",
        content: "base base ",
        bytes: 101,
        truncated: true,
      });
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("deduplicates base declaration snapshots for ranges with the same owner", async () => {
    const repo = await createGitRepo({
      baseContent: "function before() {\n  return 1;\n}\n",
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-declaration-dedupe-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const file = manifest.files[0];
      const left = file?.commentableRanges.find((range) => range.id === "range-left");
      if (!file || !left) {
        throw new Error("expected renamed file and LEFT range");
      }
      const duplicateManifest = {
        ...manifest,
        files: [
          {
            ...file,
            commentableRanges: [...file.commentableRanges, { ...left, id: "range-left-2" }],
          },
        ],
      };
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest: duplicateManifest,
          toolResponseMaxBytes: 10_000,
          structuralAnalysis: structuralAnalysisForRenamedFile(),
        },
      });
      const data = (await Bun.file(prepared.dataPath).json()) as {
        baseDeclarations: Record<string, { relativePath: string }>;
      };

      expect(data.baseDeclarations["range-left"]?.relativePath).toBe(
        data.baseDeclarations["range-left-2"]?.relativePath,
      );
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("shares the aggregate base snapshot file budget across ranges and declarations", async () => {
    const repo = await createGitRepo({
      baseContent: "function before() {\n  return 1;\n}\n",
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-snapshot-budget-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const file = manifest.files[0];
      const left = file?.commentableRanges.find((range) => range.id === "range-left");
      if (!file || !left) {
        throw new Error("expected renamed file and LEFT range");
      }
      const ranges = Array.from({ length: 513 }, (_, index) => ({
        ...left,
        id: `range-left-${index}`,
      }));
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest: {
            ...manifest,
            files: [{ ...file, commentableRanges: ranges }],
          },
          toolResponseMaxBytes: 10_000,
          structuralAnalysis: structuralAnalysisForRenamedFile(),
        },
      });
      const data = (await Bun.file(prepared.dataPath).json()) as {
        baseDeclarations: Record<string, unknown>;
        baseRanges: Record<string, { available: boolean }>;
      };

      expect(Object.values(data.baseRanges).filter((range) => range.available)).toHaveLength(512);
      expect(data.baseRanges["range-left-512"]?.available).toBe(false);
      expect(data.baseDeclarations).toEqual({});
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  }, 15_000);

  it("caps aggregate base snapshots at 16 MiB", async () => {
    const repo = await createGitRepo({
      baseContent: `${"x".repeat(9 * 1024 * 1024)}\n`,
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-snapshot-bytes-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const file = manifest.files[0];
      const left = file?.commentableRanges.find((range) => range.id === "range-left");
      if (!file || !left) {
        throw new Error("expected renamed file and LEFT range");
      }
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest: {
            ...manifest,
            files: [
              {
                ...file,
                commentableRanges: [
                  { ...left, id: "range-left-large-1" },
                  { ...left, id: "range-left-large-2" },
                ],
              },
            ],
          },
          toolResponseMaxBytes: 10 * 1024 * 1024,
        },
      });
      const data = (await Bun.file(prepared.dataPath).json()) as {
        baseRanges: Record<string, { available: boolean }>;
      };

      expect(data.baseRanges["range-left-large-1"]?.available).toBe(true);
      expect(data.baseRanges["range-left-large-2"]?.available).toBe(false);
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("reads base slices from merge base, not advanced base tip", async () => {
    const repo = await createAdvancedBaseRepo();
    try {
      const manifest = {
        ...manifestForPath("src/a.ts"),
        baseSha: repo.baseSha,
        headSha: repo.headSha,
        mergeBaseSha: repo.mergeBaseSha,
      };

      await expect(
        readAtRefWithTool({
          workspace: repo.root,
          manifest,
          path: "src/a.ts",
          ref: "base",
          rangeId: "range-left",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        content: "merge-base content\n",
        sourcePath: "src/a.ts",
      });
    } finally {
      await removeTree(repo.root);
    }
  });
});
