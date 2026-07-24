import path from "node:path";
import type { RuntimeLog } from "../shared/logging.js";
import type { DiffManifest, DiffManifestFile, DiffManifestLimitsConfig } from "../types.js";
import {
  partitionDiffManifestForPrompt,
  prepareDiffManifestPrompt,
} from "./manifest-projection.js";
import {
  analyzeDiffStructure,
  type DiffStructuralAnalysis,
  type DiffStructuralAnalysisLoader,
  type StructuralFile,
} from "./structural-analysis.js";

const defaultMaxShards = 4;

export async function shardDiffManifestForPrompt(options: {
  manifest: DiffManifest;
  config: DiffManifestLimitsConfig | undefined;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  log?: RuntimeLog;
  structuralAnalysis?: DiffStructuralAnalysisLoader;
}): Promise<DiffManifest[]> {
  const maxShards = options.config?.maxShards ?? defaultMaxShards;
  if (maxShards === 1) {
    return [options.manifest];
  }

  const fallback = cappedPromptShards(options.manifest, options.config, maxShards, options.log);
  if (fallback.length <= 1) {
    return fallback;
  }

  const analysis = await (
    options.structuralAnalysis ??
    (() =>
      analyzeDiffStructure({
        manifest: options.manifest,
        workspace: options.workspace,
        env: options.env,
        log: options.log,
      }))
  )();
  if (!analysis.available) {
    return fallback;
  }

  const files = orderFilesByStructuralRelationships(options.manifest, analysis.headFiles);
  return cappedPromptShards(
    { ...options.manifest, files },
    options.config,
    maxShards,
    options.log,
    analysis,
  );
}

function cappedPromptShards(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
  maxShards: number,
  log: RuntimeLog | undefined,
  structuralAnalysis?: DiffStructuralAnalysis,
): DiffManifest[] {
  let shards: DiffManifest[];
  try {
    shards = partitionDiffManifestForPrompt(manifest, config, structuralAnalysis);
  } catch {
    return [manifest];
  }
  if (shards.length <= maxShards) {
    return shards;
  }
  const capped = Array.from({ length: maxShards }, (_, index) => {
    const start = Math.floor((index * shards.length) / maxShards);
    const end = Math.floor(((index + 1) * shards.length) / maxShards);
    return {
      ...manifest,
      files: mergeManifestFileSlices(shards.slice(start, end).flatMap((shard) => shard.files)),
    };
  });
  const oversizedShards = capped.filter((shard) => {
    const prompt = prepareDiffManifestPrompt(shard, config, {
      allowOversizedCondensed: true,
    });
    return (
      prompt.mode === "condensed" &&
      (prompt.metrics.selected.bytes > prompt.limits.condensedMaxBytes ||
        prompt.metrics.selected.estimatedTokens > prompt.limits.condensedMaxEstimatedTokens)
    );
  }).length;
  if (oversizedShards > 0) {
    log?.warning("diff manifest shard cap requires oversized condensed prompts", {
      maxShards,
      uncappedShards: shards.length,
      oversizedShards,
    });
  }
  return capped;
}

function mergeManifestFileSlices(files: readonly DiffManifestFile[]): DiffManifestFile[] {
  const merged: DiffManifestFile[] = [];
  const indexByPath = new Map<string, number>();
  for (const file of files) {
    const index = indexByPath.get(file.path);
    if (index === undefined) {
      indexByPath.set(file.path, merged.length);
      merged.push(file);
      continue;
    }

    const existing = merged[index];
    if (!existing) {
      throw new Error(`Missing merged Diff Manifest file at index ${index}`);
    }
    const hunkKeys = new Set(existing.hunks.map((hunk) => `${hunk.hunkIndex}:${hunk.contentHash}`));
    merged[index] = {
      ...existing,
      hunks: [
        ...existing.hunks,
        ...file.hunks.filter((hunk) => !hunkKeys.has(`${hunk.hunkIndex}:${hunk.contentHash}`)),
      ],
      commentableRanges: [...existing.commentableRanges, ...file.commentableRanges],
    };
  }
  return merged;
}

function orderFilesByStructuralRelationships(
  manifest: DiffManifest,
  outlines: readonly StructuralFile[],
): DiffManifest["files"] {
  const fileIndexByPath = new Map(manifest.files.map((file, index) => [file.path, index]));
  const parents = manifest.files.map((_, index) => index);

  connectChangedImports(outlines, fileIndexByPath, parents);
  connectTestsToSources(manifest, fileIndexByPath, parents);

  const components = new Map<number, number[]>();
  for (const index of manifest.files.keys()) {
    const root = findRoot(parents, index);
    const component = components.get(root) ?? [];
    component.push(index);
    components.set(root, component);
  }

  return [...components.values()]
    .sort((left, right) => (left[0] ?? 0) - (right[0] ?? 0))
    .flatMap((component) => component.map((index) => manifest.files[index]))
    .filter((file): file is DiffManifest["files"][number] => file !== undefined);
}

function connectChangedImports(
  outlines: readonly StructuralFile[],
  fileIndexByPath: ReadonlyMap<string, number>,
  parents: number[],
): void {
  for (const outline of outlines) {
    const sourceIndex = fileIndexByPath.get(outline.path);
    if (sourceIndex === undefined) {
      continue;
    }
    for (const importSpecifier of outline.imports) {
      for (const targetPath of resolveChangedImports(
        outline.path,
        importSpecifier,
        fileIndexByPath,
      )) {
        const targetIndex = fileIndexByPath.get(targetPath);
        if (targetIndex !== undefined) {
          union(parents, sourceIndex, targetIndex);
        }
      }
    }
  }
}

function resolveChangedImports(
  sourcePath: string,
  rawImport: string,
  fileIndexByPath: ReadonlyMap<string, number>,
): string[] {
  const importPath = unquote(rawImport);
  const relativePaths = relativeImportPaths(sourcePath, importPath);
  const importSegments = pathSegments(importPath);
  let bestScore = 0;
  const matches: string[] = [];

  for (const candidate of fileIndexByPath.keys()) {
    if (candidate === sourcePath) {
      continue;
    }
    const candidatePaths = changedModulePaths(candidate);
    const exactRelativeMatch = candidatePaths.some((candidatePath) =>
      relativePaths.includes(candidatePath),
    );
    const score = exactRelativeMatch
      ? 1_000
      : Math.max(
          ...candidatePaths.map((candidatePath) =>
            longestSharedSegmentSequence(importSegments, pathSegments(candidatePath)),
          ),
        );
    if (score === 0 || score < bestScore) {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      matches.length = 0;
    }
    matches.push(candidate);
  }

  return matches;
}

function relativeImportPaths(sourcePath: string, importPath: string): string[] {
  let resolved: string | undefined;
  if (importPath.startsWith("./") || importPath.startsWith("../")) {
    resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), importPath));
  } else {
    const leadingDots = importPath.match(/^\.+/)?.[0].length ?? 0;
    if (leadingDots > 0) {
      const parentSegments = Array.from({ length: leadingDots - 1 }, () => "..");
      const modulePath = importPath.slice(leadingDots).replaceAll(".", "/");
      resolved = path.posix.normalize(
        path.posix.join(path.posix.dirname(sourcePath), ...parentSegments, modulePath),
      );
    }
  }
  if (!resolved) {
    return [];
  }
  return [resolved, withoutFileExtension(resolved)];
}

function changedModulePaths(filePath: string): string[] {
  const stem = withoutFileExtension(filePath);
  return [stem, path.posix.dirname(stem)];
}

function withoutFileExtension(filePath: string): string {
  const extension = path.posix.extname(filePath);
  return extension ? filePath.slice(0, -extension.length) : filePath;
}

function pathSegments(value: string): string[] {
  return unquote(value)
    .replace(/^<|>$/g, "")
    .split(/::|[./\\:]+/)
    .filter(Boolean);
}

function longestSharedSegmentSequence(left: readonly string[], right: readonly string[]): number {
  let longest = 0;
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      let length = 0;
      while (
        left[leftIndex + length] !== undefined &&
        left[leftIndex + length] === right[rightIndex + length]
      ) {
        length += 1;
      }
      longest = Math.max(longest, length);
    }
  }
  return longest;
}

function unquote(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  return first && last && first === last && ['"', "'", "`"].includes(first)
    ? value.slice(1, -1)
    : value;
}

function connectTestsToSources(
  manifest: DiffManifest,
  fileIndexByPath: ReadonlyMap<string, number>,
  parents: number[],
): void {
  for (const [index, file] of manifest.files.entries()) {
    const sourcePath = file.path.replace(/\.(?:test|spec)(?=\.[^.]+$)/, "");
    if (sourcePath === file.path) {
      continue;
    }
    const sourceIndex = fileIndexByPath.get(sourcePath);
    if (sourceIndex !== undefined) {
      union(parents, index, sourceIndex);
    }
  }
}

function union(parents: number[], left: number, right: number): void {
  const leftRoot = findRoot(parents, left);
  const rightRoot = findRoot(parents, right);
  if (leftRoot === rightRoot) {
    return;
  }
  parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
}

function findRoot(parents: number[], index: number): number {
  let root = index;
  while (parents[root] !== root) {
    root = parents[root] ?? root;
  }
  while (parents[index] !== index) {
    const parent = parents[index] ?? root;
    parents[index] = root;
    index = parent;
  }
  return root;
}
