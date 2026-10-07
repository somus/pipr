import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { preparePiRuntimeReadTools } from "../../pi/runtime-tools.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import {
  createGitRepo,
  executeRuntimeTool,
  executeRuntimeToolResult,
  loadRuntimeTool,
  manifestForPath,
  manifestWithPreviousPath,
  readAtRefWithTool,
  removeTree,
  renamedManifest,
  structuralAnalysisForRenamedFile,
} from "../../tests/helpers/runtime-read-tools.js";
import type { DiffManifest } from "../../types.js";
import { runAstGrepSearch } from "../ast-grep-search.js";

describe("worker runtime read tools", () => {
  it("reads bounded Diff Manifest data by path and range id", async () => {
    const result = (await readDiffWithTool({ path: "src/a.ts", rangeId: "range-1" }, 10_000)) as {
      value: { files: DiffManifest["files"] };
    };

    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.path).toBe("src/a.ts");
    expect(result.value.files[0]?.commentableRanges).toHaveLength(1);
    expect(result.value.files[0]?.commentableRanges[0]?.id).toBe("range-1");
  });

  it("rejects unknown tool paths and ranges", async () => {
    await expect(readDiffWithTool({ path: "src/missing.ts" }, 10_000)).rejects.toThrow(
      "is not in the Diff Manifest",
    );
    await expect(readDiffWithTool({ rangeId: "missing-range" }, 10_000)).rejects.toThrow(
      "Unknown Diff Manifest range",
    );
  });

  it("caps Diff Manifest tool responses", async () => {
    const result = (await readDiffWithTool({}, 12)) as {
      truncated: boolean;
      maxBytes: number;
    };

    expect(result.truncated).toBe(true);
    expect(result.maxBytes).toBe(12);
  });

  it("reads head and base file content for manifest paths", async () => {
    const repo = await createGitRepo();
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRefWithTool({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-left",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-left",
        sourcePath: "src/old.ts",
        content: "base content\n",
        truncated: false,
      });
      await expect(
        readAtRefWithTool({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        path: "src/new.ts",
        ref: "head",
        rangeId: "range-1",
        sourcePath: "src/new.ts",
        content: "head content\n",
        truncated: false,
      });
    } finally {
      await removeTree(repo.root);
    }
  });

  it("rejects unsafe paths, bad refs, and symlinks", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-"));
    try {
      await Bun.write(path.join(workspace, "target.ts"), "target\n");
      await symlink(path.join(workspace, "target.ts"), path.join(workspace, "link.ts"));
      const manifest = manifestForPath("link.ts");

      await expect(
        readAtRefWithTool({
          workspace,
          manifest,
          path: "../target.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRefWithTool({
          workspace,
          manifest: manifestForPath(".git/config"),
          path: ".git/config",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRefWithTool({
          workspace,
          manifest: manifestWithPreviousPath("safe.ts", "../old.ts"),
          path: "safe.ts",
          ref: "base",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRefWithTool({
          workspace,
          manifest,
          path: "link.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("crosses a symlink");
      await expect(
        readAtRefWithTool({
          workspace,
          manifest,
          path: "link.ts",
          ref: "main" as never,
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsupported ref");
      await expect(
        readAtRefWithTool({
          workspace,
          manifest,
          path: "link.ts",
          ref: "head",
          rangeId: "missing-range",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unknown Diff Manifest range");
    } finally {
      await removeTree(workspace);
    }
  });

  it("caps head and base file reads by range", async () => {
    const repo = await createGitRepo({
      baseContent: `${"base ".repeat(20)}\n`,
      headContent: `${"head ".repeat(20)}\n`,
    });
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRefWithTool({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-left",
          maxBytes: 10,
        }),
      ).resolves.toMatchObject({
        content: "base base ",
        bytes: 101,
        truncated: true,
      });
      await expect(
        readAtRefWithTool({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10,
        }),
      ).resolves.toMatchObject({
        content: "head head ",
        bytes: 101,
        truncated: true,
      });
    } finally {
      await removeTree(repo.root);
    }
  });

  it("reads bounded head and base enclosing declarations from structural analysis", async () => {
    const repo = await createGitRepo({
      baseContent: "function before() {\n  return 1;\n}\n",
      headContent: "function after() {\n  return 2;\n}\n",
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-declaration-tools-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest,
          toolResponseMaxBytes: 10_000,
          structuralAnalysis: structuralAnalysisForRenamedFile(),
        },
      });
      expect(prepared.toolNames).toEqual([
        "pipr_read_diff",
        "pipr_read_at_ref",
        "pipr_read_declaration",
        "pipr_ast_grep",
      ]);
      const tool = await loadRuntimeTool(prepared.dataPath, "pipr_read_declaration");

      await expect(
        executeRuntimeTool(tool, repo.root, {
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
        }),
      ).resolves.toMatchObject({
        available: true,
        sourcePath: "src/new.ts",
        declaration: {
          qualifiedName: "after",
          kind: "function",
          startLine: 1,
          endLine: 3,
        },
        content: "function after() {\n  return 2;\n}\n",
        truncated: false,
      });
      await expect(
        executeRuntimeTool(tool, repo.root, {
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-left",
        }),
      ).resolves.toMatchObject({
        available: true,
        sourcePath: "src/old.ts",
        declaration: {
          qualifiedName: "before",
          startLine: 1,
          endLine: 3,
        },
        content: "function before() {\n  return 1;\n}\n",
      });
      await expect(
        executeRuntimeTool(tool, repo.root, {
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-1",
        }),
      ).resolves.toMatchObject({
        available: false,
        sourcePath: "src/old.ts",
      });
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("bounds serialized declaration responses and returns unavailable without an owner", async () => {
    const repo = await createGitRepo({
      baseContent: `function before() {\n  return "${"b".repeat(1_000)}";\n}\n`,
      headContent: `function after() {\n  return "${"h".repeat(1_000)}";\n}\n`,
    });
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-declaration-cap-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const maxBytes = 320;
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest,
          toolResponseMaxBytes: maxBytes,
          structuralAnalysis: structuralAnalysisForRenamedFile(),
        },
      });
      const tool = await loadRuntimeTool(prepared.dataPath, "pipr_read_declaration");
      for (const params of [
        { path: "src/new.ts", ref: "head", rangeId: "range-1" },
        { path: "src/new.ts", ref: "base", rangeId: "range-left" },
      ]) {
        const result = await executeRuntimeToolResult(tool, repo.root, params);
        expect(Buffer.byteLength(result.content[0]?.text ?? "", "utf8")).toBeLessThanOrEqual(
          maxBytes,
        );
        expect(result.details).toMatchObject({ available: true, truncated: true });
      }

      const data = (await Bun.file(prepared.dataPath).json()) as {
        structuralAnalysis: { headFiles: Array<{ declarations: unknown[] }> };
        toolResponseMaxBytes: number;
      };
      const headFile = data.structuralAnalysis.headFiles[0];
      if (!headFile) {
        throw new Error("expected structural head file");
      }
      headFile.declarations = [];
      await Bun.write(prepared.dataPath, JSON.stringify(data));
      await expect(
        executeRuntimeTool(tool, repo.root, {
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
        }),
      ).resolves.toMatchObject({ available: false });

      data.toolResponseMaxBytes = 1;
      await Bun.write(prepared.dataPath, JSON.stringify(data));
      await expect(
        executeRuntimeTool(tool, repo.root, {
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
        }),
      ).rejects.toThrow("pipr_read_declaration response limit is too small");
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("runs bounded read-only structural searches over explicit safe paths", async () => {
    const repo = await createGitRepo();
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-tool-"));
    const executableDirectory = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-bin-"));
    const argsPath = path.join(executableDirectory, "args.json");
    const previousPath = process.env.PATH;
    try {
      await writeFakeAstGrepRun(executableDirectory, argsPath);
      await symlink(path.join(repo.root, "src"), path.join(repo.root, "linked-src"));
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest: renamedManifest(repo.baseSha, repo.headSha),
          toolResponseMaxBytes: 10_000,
          structuralAnalysis: structuralAnalysisForRenamedFile(),
        },
      });
      const tool = await loadRuntimeTool(prepared.dataPath, "pipr_ast_grep");
      process.env.PATH = `${executableDirectory}:${previousPath ?? ""}`;

      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "function $NAME() { $$$BODY }",
          language: "ts",
          paths: ["src"],
        }),
      ).resolves.toMatchObject({
        available: true,
        matches: [
          {
            path: "src/new.ts",
            startLine: 1,
            endLine: 3,
            text: "x".repeat(2048),
          },
        ],
        truncated: false,
      });
      expect(JSON.parse(await Bun.file(argsPath).text())).toEqual([
        "run",
        "--pattern",
        "function $NAME() { $$$BODY }",
        "--lang",
        "ts",
        "--json=compact",
        "--color",
        "never",
        "--",
        "src",
      ]);
      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "none",
          language: "ts",
          paths: ["."],
        }),
      ).resolves.toEqual({ available: true, matches: [], truncated: false });
      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "many",
          language: "ts",
          paths: ["src"],
        }),
      ).resolves.toMatchObject({
        available: true,
        matches: expect.arrayContaining([
          {
            path: "src/new.ts",
            startLine: 1,
            endLine: 3,
            text: "match 0",
          },
        ]),
        truncated: true,
      });
      const capped = (await executeRuntimeTool(tool, repo.root, {
        pattern: "many",
        language: "ts",
        paths: ["src"],
      })) as { matches: unknown[] };
      expect(capped.matches).toHaveLength(100);
      const byteCapped = await runAstGrepSearch({
        cwd: repo.root,
        params: { pattern: "many", language: "ts", paths: ["src"] },
        maxBytes: 180,
        env: process.env,
      });
      expect(Buffer.byteLength(JSON.stringify(byteCapped), "utf8")).toBeLessThanOrEqual(180);
      expect(byteCapped).toMatchObject({ truncated: true });
      await expect(
        runAstGrepSearch({
          cwd: repo.root,
          params: { pattern: "none", language: "ts", paths: ["src"] },
          maxBytes: 1,
          env: process.env,
        }),
      ).rejects.toThrow("pipr_ast_grep response limit is too small");
      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "malformed",
          language: "ts",
          paths: ["src"],
        }),
      ).rejects.toThrow("pipr_ast_grep returned invalid output");
      for (const pattern of [
        "unsafe-result-traversal",
        "unsafe-result-absolute",
        "unsafe-result-git",
        "unsafe-result-glob",
      ]) {
        await expect(
          executeRuntimeTool(tool, repo.root, {
            pattern,
            language: "ts",
            paths: ["src"],
          }),
        ).rejects.toThrow("pipr_ast_grep returned an unsafe path");
      }
      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "failure",
          language: "ts",
          paths: ["src"],
        }),
      ).rejects.toThrow("pipr_ast_grep failed");
      await expect(
        runAstGrepSearch({
          cwd: repo.root,
          params: { pattern: "sleep", language: "ts", paths: ["src"] },
          maxBytes: 10_000,
          env: process.env,
          timeoutMs: 10,
        }),
      ).rejects.toThrow("pipr_ast_grep timed out");
      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "x".repeat(4097),
          language: "ts",
          paths: ["src"],
        }),
      ).rejects.toThrow();
      for (const unsafePath of ["../src", ".git", "src/*.ts", "linked-src"]) {
        await expect(
          executeRuntimeTool(tool, repo.root, {
            pattern: "$A",
            language: "ts",
            paths: [unsafePath],
          }),
        ).rejects.toThrow();
      }
      await expect(
        executeRuntimeTool(tool, repo.root, {
          pattern: "$A",
          language: "ts",
          paths: Array.from({ length: 17 }, () => "src"),
        }),
      ).rejects.toThrow();
    } finally {
      restoreEnv("PATH", previousPath);
      await removeTree(repo.root);
      await removeTree(toolRoot);
      await removeTree(executableDirectory);
    }
  });

  it("returns unavailable instead of widening opposite-side reads to the whole hunk", async () => {
    const repo = await createGitRepo();
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRefWithTool({
          workspace: repo.root,
          manifest,
          path: "src/new.ts",
          ref: "base",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).resolves.toMatchObject({
        path: "src/new.ts",
        ref: "base",
        rangeId: "range-1",
        available: false,
      });
    } finally {
      await removeTree(repo.root);
    }
  });
});

/** Reads `reviewTestManifest()` through the worker `pipr_read_diff` tool over a hand-written runtime data file. */
async function readDiffWithTool(
  params: Record<string, unknown>,
  toolResponseMaxBytes: number,
): Promise<unknown> {
  const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-read-diff-"));
  try {
    const dataPath = path.join(toolRoot, "data.json");
    await Bun.write(
      dataPath,
      JSON.stringify({ manifest: reviewTestManifest(), toolResponseMaxBytes, baseRanges: {} }),
    );
    const tool = await loadRuntimeTool(dataPath, "pipr_read_diff");
    return await executeRuntimeTool(tool, toolRoot, params);
  } finally {
    await removeTree(toolRoot);
  }
}

async function writeFakeAstGrepRun(directory: string, argsPath: string): Promise<void> {
  const executable = path.join(directory, "ast-grep");
  const match = [
    {
      text: "x".repeat(3000),
      file: "src/new.ts",
      range: {
        start: { line: 0, column: 0 },
        end: { line: 2, column: 1 },
      },
    },
  ];
  await Bun.write(
    executable,
    [
      "#!/usr/bin/env bun",
      `await Bun.write(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      'const patternIndex = process.argv.indexOf("--pattern");',
      'if (process.argv[patternIndex + 1] === "none") {',
      '  process.stdout.write("[]");',
      "  process.exit(1);",
      "}",
      'if (process.argv[patternIndex + 1] === "malformed") {',
      '  process.stdout.write("not json");',
      "  process.exit(0);",
      "}",
      'const unsafeResultPaths = { "unsafe-result-traversal": "../outside.ts", "unsafe-result-absolute": "/outside.ts", "unsafe-result-git": ".git/config", "unsafe-result-glob": "src/*.ts" };',
      "if (unsafeResultPaths[process.argv[patternIndex + 1]]) {",
      `  process.stdout.write(JSON.stringify([{ ...${JSON.stringify(
        match[0],
      )}, file: unsafeResultPaths[process.argv[patternIndex + 1]] }]));`,
      "  process.exit(0);",
      "}",
      'if (process.argv[patternIndex + 1] === "failure") {',
      '  process.stderr.write("untrusted error details");',
      "  process.exit(2);",
      "}",
      'if (process.argv[patternIndex + 1] === "sleep") {',
      "  await Bun.sleep(1_000);",
      "}",
      'if (process.argv[patternIndex + 1] === "many") {',
      `  process.stdout.write(JSON.stringify(Array.from({ length: 101 }, (_, index) => ({ ...${JSON.stringify(match[0])}, text: \`match \${index}\` }))));`,
      "  process.exit(0);",
      "}",
      `process.stdout.write(${JSON.stringify(JSON.stringify(match))});`,
      "",
    ].join("\n"),
  );
  await chmod(executable, 0o755);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
