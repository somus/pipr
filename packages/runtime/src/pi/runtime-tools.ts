import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findEnclosingDeclaration } from "../diff/manifest-structure.js";
import type { DiffStructuralAnalysis } from "../diff/structural-analysis.js";
import type { DiffManifest } from "../types.js";
import {
  assertNoSymlinkPath,
  type BaseDeclarationSnapshot,
  type BaseRangeSnapshot,
  boundedLineSlice,
  type LineWindow,
  parseManifestPath,
  type RuntimeToolData,
  readAtRefParams,
  resolveAllowedPath,
  resolveReadAtRefRequest,
  unavailableReadAtRefResult,
} from "./runtime-tools-core.js";

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
  extensionPath: string;
  dataPath: string;
  toolNames: readonly PiRuntimeReadToolName[];
};

export async function preparePiRuntimeReadTools(options: {
  root: string;
  sourceWorkspace: string;
  request: PiRuntimeReadToolRequest;
}): Promise<PreparedPiRuntimeReadTools> {
  const toolRoot = path.join(options.root, "runtime-tools");
  const baseRoot = path.join(toolRoot, "base");
  await mkdir(baseRoot, { recursive: true });
  const baseRanges = await materializeBaseRangeSnapshots({
    baseRoot,
    manifest: options.request.manifest,
    sourceWorkspace: options.sourceWorkspace,
    maxBytes: options.request.toolResponseMaxBytes,
  });
  const baseDeclarations = options.request.structuralAnalysis
    ? await materializeBaseDeclarationSnapshots({
        baseRoot,
        manifest: options.request.manifest,
        structuralAnalysis: options.request.structuralAnalysis,
        sourceWorkspace: options.sourceWorkspace,
        maxBytes: options.request.toolResponseMaxBytes,
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
    extensionPath: await piRuntimeToolsExtensionPath(),
    dataPath,
    toolNames: options.request.structuralAnalysis
      ? [...piRuntimeReadToolNames, ...piRuntimeStructuralToolNames]
      : piRuntimeReadToolNames,
  };
}

async function materializeBaseDeclarationSnapshots(options: {
  baseRoot: string;
  manifest: DiffManifest;
  structuralAnalysis: Extract<DiffStructuralAnalysis, { available: true }>;
  sourceWorkspace: string;
  maxBytes: number;
}): Promise<Record<string, BaseDeclarationSnapshot>> {
  const declarations: Record<string, BaseDeclarationSnapshot> = {};
  for (const [fileIndex, file] of options.manifest.files.entries()) {
    for (const [rangeIndex, range] of file.commentableRanges.entries()) {
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
      const blob = readGitBlobSlice({
        cwd: options.sourceWorkspace,
        ref: options.manifest.mergeBaseSha,
        filePath: owner.sourcePath,
        window,
        maxBytes: options.maxBytes,
        allowMissing: true,
      });
      if (!blob.available || blob.content === undefined) {
        continue;
      }
      const snapshotName = `declaration-${fileIndex}-${rangeIndex}.txt`;
      await Bun.write(path.join(options.baseRoot, snapshotName), blob.content);
      declarations[range.id] = {
        path: file.path,
        ref: "base",
        sourcePath: owner.sourcePath,
        rangeId: range.id,
        declaration: owner.declaration,
        available: true,
        relativePath: path.join("base", snapshotName),
        bytes: blob.bytes,
        truncated: blob.truncated,
      };
    }
  }
  return declarations;
}

export async function piRuntimeToolsExtensionPath(): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "pi", "runtime-tools-extension.mjs"),
    path.join(moduleDir, "runtime-tools-extension.mjs"),
    path.join(moduleDir, "..", "..", "dist", "pi", "runtime-tools-extension.mjs"),
    path.join(moduleDir, "runtime-tools-extension.ts"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  throw new Error("Unable to locate pipr runtime tools extension");
}

async function pathExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}

export async function readAtRef(options: {
  workspace: string;
  manifest: DiffManifest;
  path: string;
  ref: "base" | "head";
  rangeId: string;
  maxBytes: number;
}): Promise<unknown> {
  const params = readAtRefParams({
    path: options.path,
    ref: options.ref,
    rangeId: options.rangeId,
  });
  const request = resolveReadAtRefRequest(options.manifest, params);
  if (!request.window) {
    return unavailableReadAtRefResult(request);
  }
  const content =
    params.ref === "base"
      ? readGitBlobSlice({
          cwd: options.workspace,
          ref: options.manifest.mergeBaseSha,
          filePath: request.sourcePath,
          window: request.window,
          maxBytes: options.maxBytes,
        })
      : await readWorkspaceFileSlice({
          workspace: options.workspace,
          filePath: request.sourcePath,
          window: request.window,
          maxBytes: options.maxBytes,
        });
  return {
    path: params.path,
    ref: params.ref,
    sourcePath: request.sourcePath,
    rangeId: params.rangeId,
    startLine: request.window.startLine,
    endLine: request.window.endLine,
    ...content,
  };
}

async function materializeBaseRangeSnapshots(options: {
  baseRoot: string;
  manifest: DiffManifest;
  sourceWorkspace: string;
  maxBytes: number;
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
      if (!request.window) {
        ranges[range.id] = unavailableReadAtRefResult(request);
        continue;
      }
      const blob = readGitBlobSlice({
        cwd: options.sourceWorkspace,
        ref: options.manifest.mergeBaseSha,
        filePath: request.sourcePath,
        window: request.window,
        maxBytes: options.maxBytes,
        allowMissing: true,
      });
      if (!blob.available || blob.content === undefined) {
        ranges[range.id] = unavailableReadAtRefResult(request);
        continue;
      }
      const snapshotName = `${index}-${rangeIndex}.txt`;
      await Bun.write(path.join(options.baseRoot, snapshotName), blob.content);
      ranges[range.id] = {
        path: file.path,
        ref: "base",
        sourcePath: request.sourcePath,
        rangeId: range.id,
        startLine: request.window.startLine,
        endLine: request.window.endLine,
        available: true,
        relativePath: path.join("base", snapshotName),
        bytes: blob.bytes,
        truncated: blob.truncated,
      };
    }
  }
  return ranges;
}

function readGitBlobSlice(options: {
  cwd: string;
  ref: string;
  filePath: string;
  window: LineWindow;
  maxBytes: number;
  allowMissing?: boolean;
}): { available: boolean; content?: string; bytes?: number; truncated?: boolean } {
  const result = Bun.spawnSync(["git", "show", `${options.ref}:${options.filePath}`], {
    cwd: options.cwd,
    env: process.env,
    maxBuffer: 16 * 1024 * 1024,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    if (options.allowMissing) {
      return { available: false };
    }
    throw new Error(`Unable to read '${options.filePath}' at ${options.ref}`);
  }
  return boundedLineSlice(result.stdout.toString(), options.window, options.maxBytes);
}

async function readWorkspaceFileSlice(options: {
  workspace: string;
  filePath: string;
  window: LineWindow;
  maxBytes: number;
}): Promise<{ available: boolean; content?: string; bytes?: number; truncated?: boolean }> {
  const resolved = resolveAllowedPath(options.workspace, options.filePath);
  await assertNoSymlinkPath(options.workspace, options.filePath);
  const content = await Bun.file(resolved).text();
  return boundedLineSlice(content, options.window, options.maxBytes);
}
