import { describe, expect, it } from "bun:test";
import { access, chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runGit as runGitCommand } from "../../diff/git.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { DiffManifest } from "../../types.js";
import { preparePiCustomTools } from "../custom-tools.js";
import { preparePiRuntimeReadTools, readAtRef } from "../runtime-tools.js";
import { readDiffFromRuntimeData, runAstGrepSearch } from "../runtime-tools-core.js";

describe("pipr runtime Pi read tools", () => {
  it("reads bounded Diff Manifest data by path and range id", () => {
    const result = readDiffFromRuntimeData(
      { manifest: reviewTestManifest(), toolResponseMaxBytes: 10_000, baseRanges: {} },
      {
        path: "src/a.ts",
        rangeId: "range-1",
      },
    ) as { value: { files: DiffManifest["files"] } };

    expect(result.value.files).toHaveLength(1);
    expect(result.value.files[0]?.path).toBe("src/a.ts");
    expect(result.value.files[0]?.commentableRanges).toHaveLength(1);
    expect(result.value.files[0]?.commentableRanges[0]?.id).toBe("range-1");
  });

  it("rejects unknown tool paths and ranges", () => {
    expect(() =>
      readDiffFromRuntimeData(
        { manifest: reviewTestManifest(), toolResponseMaxBytes: 10_000, baseRanges: {} },
        { path: "src/missing.ts" },
      ),
    ).toThrow("is not in the Diff Manifest");
    expect(() =>
      readDiffFromRuntimeData(
        { manifest: reviewTestManifest(), toolResponseMaxBytes: 10_000, baseRanges: {} },
        { rangeId: "missing-range" },
      ),
    ).toThrow("Unknown Diff Manifest range");
  });

  it("caps Diff Manifest tool responses", () => {
    const result = readDiffFromRuntimeData(
      { manifest: reviewTestManifest(), toolResponseMaxBytes: 12, baseRanges: {} },
      {},
    ) as {
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
        readAtRef({
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
        readAtRef({
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
        readAtRef({
          workspace,
          manifest,
          path: "../target.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRef({
          workspace,
          manifest: manifestForPath(".git/config"),
          path: ".git/config",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRef({
          workspace,
          manifest: manifestWithPreviousPath("safe.ts", "../old.ts"),
          path: "safe.ts",
          ref: "base",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsafe manifest path");
      await expect(
        readAtRef({
          workspace,
          manifest,
          path: "link.ts",
          ref: "head",
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("crosses a symlink");
      await expect(
        readAtRef({
          workspace,
          manifest,
          path: "link.ts",
          ref: "main" as never,
          rangeId: "range-1",
          maxBytes: 10_000,
        }),
      ).rejects.toThrow("Unsupported ref");
      await expect(
        readAtRef({
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
        readAtRef({
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
        readAtRef({
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

  it("loads static runtime extension tools with range-scoped base truncation metadata", async () => {
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
      expect(["runtime-tools-extension.ts", "runtime-tools-extension.mjs"]).toContain(
        path.basename(prepared.extensionPath),
      );
      expect(path.dirname(prepared.extensionPath)).not.toBe(path.join(toolRoot, "runtime-tools"));
      await access(prepared.dataPath);
      await expect(
        access(path.join(toolRoot, "runtime-tools", "pipr-runtime-tools.mjs")),
      ).rejects.toThrow();
      const atRefTool = await loadExtensionTool(
        prepared.extensionPath,
        "pipr_read_at_ref",
        prepared.dataPath,
      );

      const result = await executeExtensionTool(atRefTool, repo.root, {
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
      const tool = await loadExtensionTool(
        prepared.extensionPath,
        "pipr_read_declaration",
        prepared.dataPath,
      );

      await expect(
        executeExtensionTool(tool, repo.root, {
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
        executeExtensionTool(tool, repo.root, {
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
        executeExtensionTool(tool, repo.root, {
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
      const tool = await loadExtensionTool(
        prepared.extensionPath,
        "pipr_read_declaration",
        prepared.dataPath,
      );
      for (const params of [
        { path: "src/new.ts", ref: "head", rangeId: "range-1" },
        { path: "src/new.ts", ref: "base", rangeId: "range-left" },
      ]) {
        const result = await executeExtensionToolResult(tool, repo.root, params);
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
        executeExtensionTool(tool, repo.root, {
          path: "src/new.ts",
          ref: "head",
          rangeId: "range-1",
        }),
      ).resolves.toMatchObject({ available: false });

      data.toolResponseMaxBytes = 1;
      await Bun.write(prepared.dataPath, JSON.stringify(data));
      await expect(
        executeExtensionTool(tool, repo.root, {
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
      const tool = await loadExtensionTool(
        prepared.extensionPath,
        "pipr_ast_grep",
        prepared.dataPath,
      );
      process.env.PATH = `${executableDirectory}:${previousPath ?? ""}`;

      await expect(
        executeExtensionTool(tool, repo.root, {
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
        executeExtensionTool(tool, repo.root, {
          pattern: "none",
          language: "ts",
          paths: ["."],
        }),
      ).resolves.toEqual({ available: true, matches: [], truncated: false });
      await expect(
        executeExtensionTool(tool, repo.root, {
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
      const capped = (await executeExtensionTool(tool, repo.root, {
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
        executeExtensionTool(tool, repo.root, {
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
          executeExtensionTool(tool, repo.root, {
            pattern,
            language: "ts",
            paths: ["src"],
          }),
        ).rejects.toThrow("pipr_ast_grep returned an unsafe path");
      }
      await expect(
        executeExtensionTool(tool, repo.root, {
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
        executeExtensionTool(tool, repo.root, {
          pattern: "x".repeat(4097),
          language: "ts",
          paths: ["src"],
        }),
      ).rejects.toThrow();
      for (const unsafePath of ["../src", ".git", "src/*.ts", "linked-src"]) {
        await expect(
          executeExtensionTool(tool, repo.root, {
            pattern: "$A",
            language: "ts",
            paths: [unsafePath],
          }),
        ).rejects.toThrow();
      }
      await expect(
        executeExtensionTool(tool, repo.root, {
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

  it("fails clearly when runtime tool data env is missing", async () => {
    const repo = await createGitRepo();
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-env-"));
    const previousDataPath = process.env.PIPR_RUNTIME_TOOLS_DATA;
    try {
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: {
          manifest: renamedManifest(repo.baseSha, repo.headSha),
          toolResponseMaxBytes: 10,
        },
      });
      delete process.env.PIPR_RUNTIME_TOOLS_DATA;
      const extension = await import(pathToFileURL(prepared.extensionPath).href);

      expect(() => extension.default({ registerTool() {} })).toThrow(
        "PIPR_RUNTIME_TOOLS_DATA or PIPR_CUSTOM_TOOLS_DATA is required",
      );
    } finally {
      restoreEnv("PIPR_RUNTIME_TOOLS_DATA", previousDataPath);
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("round trips custom config tools through the static extension bridge", async () => {
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-custom-tools-extension-"));
    let observedContext: unknown;
    const prepared = await preparePiCustomTools({
      root: toolRoot,
      request: {
        context: { run: { id: "run-1" } },
        tools: [
          {
            name: "plugin_echo",
            description: "Echo input.",
            input: summarySchema(),
            output: summarySchema(),
            async execute(context, input) {
              observedContext = context;
              return { body: `stored:${(input as { body: string }).body}` };
            },
          },
        ],
      },
    });
    try {
      const tool = await loadExtensionToolWithEnv(prepared.extensionPath, "plugin_echo", {
        PIPR_CUSTOM_TOOLS_DATA: prepared.dataPath,
        PIPR_CUSTOM_TOOLS_BRIDGE_URL: prepared.bridgeUrl,
        PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN: prepared.bridgeToken,
      });

      await expect(executeExtensionTool(tool, process.cwd(), { body: "memory" })).resolves.toEqual({
        body: "stored:memory",
      });
      expect(observedContext).toEqual({ run: { id: "run-1" } });
    } finally {
      await prepared.close();
      await removeTree(toolRoot);
    }
  });

  it("reports custom config tool input and output validation errors", async () => {
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-custom-tools-validation-"));
    const prepared = await preparePiCustomTools({
      root: toolRoot,
      request: {
        context: {},
        tools: [
          {
            name: "plugin_strict",
            description: "Validate input.",
            input: summarySchema(),
            output: summarySchema(),
            async execute() {
              return { title: "missing body" };
            },
          },
        ],
      },
    });
    try {
      const tool = await loadExtensionToolWithEnv(prepared.extensionPath, "plugin_strict", {
        PIPR_CUSTOM_TOOLS_DATA: prepared.dataPath,
        PIPR_CUSTOM_TOOLS_BRIDGE_URL: prepared.bridgeUrl,
        PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN: prepared.bridgeToken,
      });

      await expect(executeExtensionTool(tool, process.cwd(), { title: "missing" })).rejects.toThrow(
        "summary.body is required",
      );
      await expect(executeExtensionTool(tool, process.cwd(), { body: "ok" })).rejects.toThrow(
        "summary.body is required",
      );
    } finally {
      await prepared.close();
      await removeTree(toolRoot);
    }
  });

  it("keeps typed helpers and static extension tools in parity", async () => {
    const repo = await createGitRepo();
    const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-tools-parity-"));
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);
      const prepared = await preparePiRuntimeReadTools({
        root: toolRoot,
        sourceWorkspace: repo.root,
        request: { manifest, toolResponseMaxBytes: 10_000 },
      });
      const diffTool = await loadExtensionTool(
        prepared.extensionPath,
        "pipr_read_diff",
        prepared.dataPath,
      );
      const atRefTool = await loadExtensionTool(
        prepared.extensionPath,
        "pipr_read_at_ref",
        prepared.dataPath,
      );

      const diffParams = { path: "src/new.ts", rangeId: "range-1" };
      expect(await executeExtensionTool(diffTool, repo.root, diffParams)).toEqual(
        readDiffFromRuntimeData(
          { manifest, toolResponseMaxBytes: 10_000, baseRanges: {} },
          diffParams,
        ),
      );

      const atRefParams = { path: "src/new.ts", ref: "head" as const, rangeId: "range-1" };
      expect(await executeExtensionTool(atRefTool, repo.root, atRefParams)).toEqual(
        await readAtRef({
          workspace: repo.root,
          manifest,
          ...atRefParams,
          maxBytes: 10_000,
        }),
      );

      expect(() =>
        readDiffFromRuntimeData(
          { manifest, toolResponseMaxBytes: 10_000, baseRanges: {} },
          { path: "src/missing.ts" },
        ),
      ).toThrow("is not in the Diff Manifest");
      await expect(
        executeExtensionTool(diffTool, repo.root, { path: "src/missing.ts" }),
      ).rejects.toThrow("is not in the Diff Manifest");
    } finally {
      await removeTree(repo.root);
      await removeTree(toolRoot);
    }
  });

  it("returns unavailable instead of widening opposite-side reads to the whole hunk", async () => {
    const repo = await createGitRepo();
    try {
      const manifest = renamedManifest(repo.baseSha, repo.headSha);

      await expect(
        readAtRef({
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
        readAtRef({
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

async function createGitRepo(
  options: { baseContent?: string; headContent?: string } = {},
): Promise<{ root: string; baseSha: string; headSha: string }> {
  const root = await initTestGitRepo("pipr-runtime-tools-git-");
  await Bun.write(path.join(root, "src", "old.ts"), options.baseContent ?? "base content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  runGit(root, ["mv", "src/old.ts", "src/new.ts"]);
  await Bun.write(path.join(root, "src", "new.ts"), options.headContent ?? "head content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "head"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  return { root, baseSha, headSha };
}

function renamedManifest(baseSha: string, headSha: string): DiffManifest {
  const file = manifestForPath("src/new.ts").files[0];
  if (!file) {
    throw new Error("missing test manifest file");
  }
  return {
    ...manifestForPath("src/new.ts"),
    baseSha,
    headSha,
    mergeBaseSha: baseSha,
    files: [
      {
        ...file,
        previousPath: "src/old.ts",
        status: "renamed",
      },
    ],
  };
}

function manifestForPath(filePath: string): DiffManifest {
  const hunkHeader = "@@ -1 +1 @@";
  const hunkContentHash = "abcdefabcdef";
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [
      {
        path: filePath,
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [
          {
            hunkIndex: 1,
            header: hunkHeader,
            oldStart: 1,
            oldLines: 1,
            newStart: 1,
            newLines: 1,
            contentHash: hunkContentHash,
          },
        ],
        commentableRanges: [
          {
            id: "range-left",
            path: filePath,
            side: "LEFT",
            startLine: 1,
            endLine: 1,
            kind: "deleted",
            hunkIndex: 1,
            hunkHeader,
            hunkContentHash,
          },
          {
            id: "range-1",
            path: filePath,
            side: "RIGHT",
            startLine: 1,
            endLine: 1,
            kind: "mixed",
            hunkIndex: 1,
            hunkHeader,
            hunkContentHash,
          },
        ],
      },
    ],
  };
}

function manifestWithPreviousPath(filePath: string, previousPath: string): DiffManifest {
  const file = manifestForPath(filePath).files[0];
  if (!file) {
    throw new Error("missing test manifest file");
  }
  return {
    ...manifestForPath(filePath),
    files: [{ ...file, previousPath }],
  };
}

function structuralAnalysisForRenamedFile() {
  return {
    available: true as const,
    version: "0.44.1",
    headFiles: [
      {
        path: "src/new.ts",
        language: "TypeScript",
        imports: [],
        declarations: [
          {
            qualifiedName: "after",
            kind: "function",
            startLine: 1,
            endLine: 3,
            isExported: false,
          },
        ],
      },
    ],
    baseFiles: [
      {
        path: "src/old.ts",
        language: "TypeScript",
        imports: [],
        declarations: [
          {
            qualifiedName: "before",
            kind: "function",
            startLine: 1,
            endLine: 3,
            isExported: false,
          },
        ],
      },
    ],
    diagnostics: { durationMs: 1, fileCount: 2, declarationCount: 2 },
  };
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

function runGit(cwd: string, args: string[]): string {
  return runGitCommand(args, cwd);
}

async function removeTree(root: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 9) {
        throw error;
      }
      await delay(50);
    }
  }
}

async function initTestGitRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  runGit(root, ["init", "-b", "main"]);
  runGit(root, ["config", "user.name", "pipr test"]);
  runGit(root, ["config", "user.email", "pipr@example.test"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);
  await mkdir(path.join(root, "src"));
  return root;
}

async function createAdvancedBaseRepo(): Promise<{
  root: string;
  mergeBaseSha: string;
  baseSha: string;
  headSha: string;
}> {
  const root = await initTestGitRepo("pipr-runtime-tools-advanced-base-");
  await Bun.write(path.join(root, "src", "a.ts"), "merge-base content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "merge base"]);
  const mergeBaseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  await Bun.write(path.join(root, "src", "a.ts"), "advanced base content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "advanced base"]);
  const baseSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  runGit(root, ["checkout", "-b", "feature", mergeBaseSha]);
  await Bun.write(path.join(root, "src", "a.ts"), "head content\n");
  runGit(root, ["add", "."]);
  runGit(root, ["commit", "-m", "head"]);
  const headSha = runGit(root, ["rev-parse", "HEAD"]).trim();
  return { root, mergeBaseSha, baseSha, headSha };
}

async function loadExtensionTool(
  extensionPath: string,
  toolName: string,
  dataPath: string,
): Promise<{
  execute: (...args: unknown[]) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
}> {
  return await loadExtensionToolWithEnv(extensionPath, toolName, {
    PIPR_RUNTIME_TOOLS_DATA: dataPath,
  });
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

async function loadExtensionToolWithEnv(
  extensionPath: string,
  toolName: string,
  env: Record<string, string>,
): Promise<{
  execute: (...args: unknown[]) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
}> {
  const tools = new Map<string, unknown>();
  const envKeys = [
    "PIPR_RUNTIME_TOOLS_DATA",
    "PIPR_CUSTOM_TOOLS_DATA",
    "PIPR_CUSTOM_TOOLS_BRIDGE_URL",
    "PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN",
  ];
  const previous = new Map(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) {
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    const extension = await import(pathToFileURL(extensionPath).href);
    await extension.default({
      registerTool(tool: { name: string }) {
        tools.set(tool.name, tool);
      },
    });
  } finally {
    for (const [key, value] of previous) {
      restoreEnv(key, value);
    }
  }
  const tool = tools.get(toolName);
  if (!tool || typeof tool !== "object" || !("execute" in tool)) {
    throw new Error(`missing extension tool ${toolName}`);
  }
  return tool as {
    execute: (
      ...args: unknown[]
    ) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
  };
}

function summarySchema() {
  return {
    parse(value: unknown) {
      if (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "body") === "string"
      ) {
        return { body: Reflect.get(value, "body") as string };
      }
      throw new Error("summary.body is required");
    },
  };
}

async function executeExtensionTool(
  tool: {
    execute: (
      ...args: unknown[]
    ) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
  },
  cwd: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await tool.execute("test", params, undefined, undefined, { cwd });
  return result.details ?? JSON.parse(result.content[0]?.text ?? "{}");
}

async function executeExtensionToolResult(
  tool: {
    execute: (
      ...args: unknown[]
    ) => Promise<{ details?: unknown; content: Array<{ text: string }> }>;
  },
  cwd: string,
  params: Record<string, unknown>,
) {
  return await tool.execute("test", params, undefined, undefined, { cwd });
}
