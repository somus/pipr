import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRuntimeReadTools } from "../../agent-worker/runtime-read-tools.js";
import { runGit as runGitCommand } from "../../diff/git.js";
import { preparePiRuntimeReadTools } from "../../pi/runtime-tools.js";
import type { DiffManifest } from "../../types.js";

export async function createGitRepo(
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

export function renamedManifest(baseSha: string, headSha: string): DiffManifest {
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

export function manifestForPath(filePath: string): DiffManifest {
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

export function manifestWithPreviousPath(filePath: string, previousPath: string): DiffManifest {
  const file = manifestForPath(filePath).files[0];
  if (!file) {
    throw new Error("missing test manifest file");
  }
  return {
    ...manifestForPath(filePath),
    files: [{ ...file, previousPath }],
  };
}

export function structuralAnalysisForRenamedFile() {
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

function runGit(cwd: string, args: string[]): string {
  return runGitCommand(args, cwd);
}

export async function removeTree(root: string): Promise<void> {
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

export async function createAdvancedBaseRepo(): Promise<{
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

/** Prepares runtime data for `manifest` and reads one range through the worker `pipr_read_at_ref` tool. */
export async function readAtRefWithTool(options: {
  workspace: string;
  manifest: DiffManifest;
  path: string;
  ref: "base" | "head";
  rangeId: string;
  maxBytes: number;
}): Promise<unknown> {
  const toolRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-read-at-ref-"));
  try {
    const prepared = await preparePiRuntimeReadTools({
      root: toolRoot,
      sourceWorkspace: options.workspace,
      request: { manifest: options.manifest, toolResponseMaxBytes: options.maxBytes },
    });
    const tool = await loadRuntimeTool(prepared.dataPath, "pipr_read_at_ref");
    return await executeRuntimeTool(tool, options.workspace, {
      path: options.path,
      ref: options.ref,
      rangeId: options.rangeId,
    });
  } finally {
    await removeTree(toolRoot);
  }
}

export async function loadRuntimeTool(dataPath: string, toolName: string): Promise<RuntimeTool> {
  return {
    async execute(cwd, params) {
      const tool = (await createRuntimeReadTools(dataPath, cwd)).find(
        (candidate) => candidate.name === toolName,
      );
      if (!tool) {
        throw new Error(`missing runtime tool ${toolName}`);
      }
      return (await tool.execute(
        params as never,
        { callId: "test" } as never,
        BACKGROUND_CONTEXT,
      )) as never;
    },
  };
}

type RuntimeTool = {
  execute(
    cwd: string,
    params: Record<string, unknown>,
  ): Promise<{ details?: unknown; content: Array<{ text: string }> }>;
};

export async function executeRuntimeTool(
  tool: RuntimeTool,
  cwd: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await executeRuntimeToolResult(tool, cwd, params);
  return result.details ?? JSON.parse(result.content[0]?.text ?? "{}");
}

export async function executeRuntimeToolResult(
  tool: RuntimeTool,
  cwd: string,
  params: Record<string, unknown>,
) {
  return await tool.execute(cwd, params);
}
