import { describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { runGit as runGitCommand } from "../../diff/git.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { DiffManifest } from "../../types.js";
import { preparePiCustomTools } from "../custom-tools.js";
import { preparePiRuntimeReadTools, readAtRef } from "../runtime-tools.js";
import { readDiffFromRuntimeData } from "../runtime-tools-core.js";

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
