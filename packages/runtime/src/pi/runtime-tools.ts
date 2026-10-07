import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type BaseDeclarationSnapshot,
  type BaseRangeSnapshot,
  boundedLineSlice,
  type LineWindow,
  parseManifestPath,
  type RuntimeToolData,
  resolveReadAtRefRequest,
  unavailableReadAtRefResult,
} from "../agent-worker/runtime-tool-data.js";
import { findEnclosingDeclaration } from "../diff/manifest-structure.js";
import type { DiffStructuralAnalysis } from "../diff/structural-analysis.js";
import type { DiffManifest } from "../types.js";

export const piRuntimeReadToolNames = ["pipr_read_diff", "pipr_read_at_ref"] as const;
export const piRuntimeStructuralToolNames = ["pipr_read_declaration", "pipr_ast_grep"] as const;

export type PiRuntimeReadToolName =
  | (typeof piRuntimeReadToolNames)[number]
  | (typeof piRuntimeStructuralToolNames)[number];

export type PiRuntimeReadToolRequest = {
  manifest: DiffManifest;
  toolResponseMaxBytes: number;
  structuralAnalysis?: Extract<DiffStructuralAnalysis, { available: true }>;
};

export type PreparedPiRuntimeReadTools = {
  dataPath: string;
  toolNames: readonly PiRuntimeReadToolName[];
};

type SnapshotBudget = {
  remainingBytes: number;
  remainingFiles: number;
};

type MaterializedSnapshot = {
  relativePath: string;
  bytes: number;
  truncated: boolean;
};

const maxBaseSnapshotBytes = 16 * 1024 * 1024;
const maxBaseSnapshotFiles = 512;

export async function preparePiRuntimeReadTools(options: {
  root: string;
  sourceWorkspace: string;
  request: PiRuntimeReadToolRequest;
  env?: NodeJS.ProcessEnv;
}): Promise<PreparedPiRuntimeReadTools> {
  const toolRoot = path.join(options.root, "runtime-tools");
  const baseRoot = path.join(toolRoot, "base");
  await mkdir(baseRoot, { recursive: true });
  const snapshotBudget: SnapshotBudget = {
    remainingBytes: maxBaseSnapshotBytes,
    remainingFiles: maxBaseSnapshotFiles,
  };
  const writeSnapshot = createBaseSnapshotWriter({
    baseRoot,
    sourceWorkspace: options.sourceWorkspace,
    env: options.env,
    mergeBaseSha: options.request.manifest.mergeBaseSha,
    snapshotBudget,
  });
  const baseRanges = await materializeBaseRangeSnapshots({
    manifest: options.request.manifest,
    maxBytes: options.request.toolResponseMaxBytes,
    writeSnapshot,
  });
  const baseDeclarations = options.request.structuralAnalysis
    ? await materializeBaseDeclarationSnapshots({
        manifest: options.request.manifest,
        structuralAnalysis: options.request.structuralAnalysis,
        maxBytes: options.request.toolResponseMaxBytes,
        snapshotBudget,
        writeSnapshot,
      })
    : {};
  const data: RuntimeToolData = {
    manifest: options.request.manifest,
    toolResponseMaxBytes: options.request.toolResponseMaxBytes,
    baseRanges,
    baseDeclarations,
    structuralAnalysis: options.request.structuralAnalysis,
  };
  const dataPath = path.join(toolRoot, "data.json");
  await Bun.write(dataPath, JSON.stringify(data));
  return {
    dataPath,
    toolNames: options.request.structuralAnalysis
      ? [...piRuntimeReadToolNames, ...piRuntimeStructuralToolNames]
      : piRuntimeReadToolNames,
  };
}

async function materializeBaseDeclarationSnapshots(options: {
  manifest: DiffManifest;
  structuralAnalysis: Extract<DiffStructuralAnalysis, { available: true }>;
  maxBytes: number;
  snapshotBudget: SnapshotBudget;
  writeSnapshot: BaseSnapshotWriter;
}): Promise<Record<string, BaseDeclarationSnapshot>> {
  const declarations: Record<string, BaseDeclarationSnapshot> = {};
  const snapshots = new Map<string, MaterializedSnapshot>();
  for (const [fileIndex, file] of options.manifest.files.entries()) {
    for (const range of file.commentableRanges) {
      if (range.side !== "LEFT") {
        continue;
      }
      const owner = findEnclosingDeclaration(file, range, options.structuralAnalysis);
      if (owner?.ref !== "base") {
        continue;
      }
      const window = {
        startLine: owner.declaration.startLine,
        endLine: owner.declaration.endLine,
      };
      const snapshot = await materializeBaseDeclarationSnapshot(options, snapshots, {
        name: `declaration-${fileIndex}-${snapshots.size}.txt`,
        sourcePath: owner.sourcePath,
        window,
      });
      if (!snapshot) {
        continue;
      }
      declarations[range.id] = {
        path: file.path,
        ref: "base",
        sourcePath: owner.sourcePath,
        rangeId: range.id,
        declaration: owner.declaration,
        available: true,
        ...snapshot,
      };
    }
  }
  return declarations;
}

/** Reuses an identical declaration window, otherwise writes one while the snapshot budget lasts. */
async function materializeBaseDeclarationSnapshot(
  options: { maxBytes: number; snapshotBudget: SnapshotBudget; writeSnapshot: BaseSnapshotWriter },
  snapshots: Map<string, MaterializedSnapshot>,
  target: { name: string; sourcePath: string; window: LineWindow },
): Promise<MaterializedSnapshot | undefined> {
  const key = JSON.stringify([target.sourcePath, target.window.startLine, target.window.endLine]);
  const existing = snapshots.get(key);
  if (existing) return existing;
  const budget = options.snapshotBudget;
  if (budget.remainingFiles === 0 || budget.remainingBytes === 0) return undefined;
  const snapshot = await options.writeSnapshot(
    target.name,
    target.sourcePath,
    target.window,
    Math.min(options.maxBytes, budget.remainingBytes),
  );
  if (snapshot) snapshots.set(key, snapshot);
  return snapshot;
}

async function materializeBaseRangeSnapshots(options: {
  manifest: DiffManifest;
  maxBytes: number;
  writeSnapshot: BaseSnapshotWriter;
}): Promise<Record<string, BaseRangeSnapshot>> {
  const ranges: Record<string, BaseRangeSnapshot> = {};
  for (const [index, file] of options.manifest.files.entries()) {
    try {
      parseManifestPath(file.path);
    } catch {
      continue;
    }
    for (const [rangeIndex, range] of file.commentableRanges.entries()) {
      const request = resolveReadAtRefRequest(options.manifest, {
        path: file.path,
        ref: "base",
        rangeId: range.id,
      });
      const snapshot =
        request.window &&
        (await options.writeSnapshot(
          `${index}-${rangeIndex}.txt`,
          request.sourcePath,
          request.window,
          options.maxBytes,
        ));
      ranges[range.id] =
        snapshot && request.window
          ? {
              path: file.path,
              ref: "base",
              sourcePath: request.sourcePath,
              rangeId: range.id,
              startLine: request.window.startLine,
              endLine: request.window.endLine,
              available: true,
              ...snapshot,
            }
          : unavailableReadAtRefResult(request);
    }
  }
  return ranges;
}

type BaseSnapshotWriter = (
  name: string,
  sourcePath: string,
  window: LineWindow,
  maxBytes: number,
) => Promise<MaterializedSnapshot | undefined>;

/**
 * Writes bounded merge-base slices into `baseRoot` within the shared snapshot budget. Manifest ranges and
 * declarations are visited file by file, so the most recently read blob is reused instead of running one
 * `git show` per range.
 */
function createBaseSnapshotWriter(options: {
  baseRoot: string;
  sourceWorkspace: string;
  env: NodeJS.ProcessEnv | undefined;
  mergeBaseSha: string;
  snapshotBudget: SnapshotBudget;
}): BaseSnapshotWriter {
  let cached: { sourcePath: string; content: string | undefined } | undefined;
  return async (name, sourcePath, window, maxBytes) => {
    if (cached?.sourcePath !== sourcePath) {
      cached = {
        sourcePath,
        content: readGitBlob(options, sourcePath),
      };
    }
    if (cached.content === undefined) {
      return undefined;
    }
    const slice = boundedLineSlice(cached.content, window, maxBytes);
    if (!consumeSnapshotBudget(options.snapshotBudget, Buffer.byteLength(slice.content, "utf8"))) {
      return undefined;
    }
    await Bun.write(path.join(options.baseRoot, name), slice.content);
    return {
      relativePath: path.join("base", name),
      bytes: slice.bytes,
      truncated: slice.truncated,
    };
  };
}

function consumeSnapshotBudget(budget: SnapshotBudget, bytes: number): boolean {
  if (budget.remainingFiles === 0 || bytes > budget.remainingBytes) {
    return false;
  }
  budget.remainingFiles -= 1;
  budget.remainingBytes -= bytes;
  return true;
}

/** Returns the blob at `ref`, or undefined when git cannot read it. */
function readGitBlob(
  source: { sourceWorkspace: string; mergeBaseSha: string; env: NodeJS.ProcessEnv | undefined },
  filePath: string,
): string | undefined {
  const result = Bun.spawnSync(["git", "show", `${source.mergeBaseSha}:${filePath}`], {
    cwd: source.sourceWorkspace,
    env: source.env ?? process.env,
    maxBuffer: 16 * 1024 * 1024,
    stderr: "pipe",
    stdout: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString() : undefined;
}
