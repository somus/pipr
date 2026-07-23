import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { RuntimeLog } from "../shared/logging.js";
import type { DiffManifest, DiffManifestFile, DiffManifestLimitsConfig } from "../types.js";
import {
  partitionDiffManifestForPrompt,
  prepareDiffManifestPrompt,
} from "./manifest-projection.js";

const outlineItemSchema = z.object({
  name: z.string(),
  isImport: z.boolean(),
});

const outlineFileSchema = z.object({
  path: z.string(),
  items: z.array(outlineItemSchema),
});

const outlineOutputSchema = z.array(outlineFileSchema);

type OutlineFile = z.infer<typeof outlineFileSchema>;
const defaultMaxShards = 4;

export async function shardDiffManifestForPrompt(options: {
  manifest: DiffManifest;
  config: DiffManifestLimitsConfig | undefined;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  log?: RuntimeLog;
}): Promise<DiffManifest[]> {
  const maxShards = options.config?.maxShards ?? defaultMaxShards;
  if (maxShards === 1) {
    return [options.manifest];
  }

  const fallback = cappedPromptShards(options.manifest, options.config, maxShards, options.log);
  if (fallback.length <= 1) {
    return fallback;
  }

  const outlines = await loadChangedFileOutlines(options);
  if (!outlines) {
    return fallback;
  }

  const files = orderFilesByStructuralRelationships(options.manifest, outlines);
  return cappedPromptShards({ ...options.manifest, files }, options.config, maxShards, options.log);
}

function cappedPromptShards(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
  maxShards: number,
  log: RuntimeLog | undefined,
): DiffManifest[] {
  let shards: DiffManifest[];
  try {
    shards = partitionDiffManifestForPrompt(manifest, config);
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

async function loadChangedFileOutlines(options: {
  manifest: DiffManifest;
  workspace: string;
  env?: NodeJS.ProcessEnv;
  log?: RuntimeLog;
}): Promise<OutlineFile[] | undefined> {
  const filePaths = options.manifest.files
    .filter((file) => file.status !== "removed" && file.hunks.length > 0)
    .map((file) => file.path);
  if (filePaths.length === 0) {
    return undefined;
  }

  const configPath = path.join(os.tmpdir(), `pipr-ast-grep-${randomUUID()}.yml`);
  try {
    await Bun.write(configPath, "{}\n");
    const child = Bun.spawn(
      [
        "ast-grep",
        "outline",
        "--items",
        "all",
        "--view",
        "expanded",
        "--json=compact",
        "--color",
        "never",
        "--config",
        configPath,
        "--",
        ...filePaths,
      ],
      {
        cwd: options.workspace,
        env: options.env ?? process.env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode !== 0) {
      options.log?.warning("diff manifest structural sharding fallback", {
        reason: "ast-grep-exit",
        exitCode,
      });
      options.log?.textSnippet("debug", "ast-grep outline stderr", stderr);
      return undefined;
    }
    const parsed = outlineOutputSchema.safeParse(JSON.parse(stdout));
    if (!parsed.success) {
      options.log?.warning("diff manifest structural sharding fallback", {
        reason: "invalid-outline-output",
      });
      return undefined;
    }
    return parsed.data;
  } catch {
    options.log?.warning("diff manifest structural sharding fallback", {
      reason: "ast-grep-unavailable",
    });
    return undefined;
  } finally {
    await rm(configPath, { force: true });
  }
}

function orderFilesByStructuralRelationships(
  manifest: DiffManifest,
  outlines: readonly OutlineFile[],
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
  outlines: readonly OutlineFile[],
  fileIndexByPath: ReadonlyMap<string, number>,
  parents: number[],
): void {
  for (const outline of outlines) {
    const sourceIndex = fileIndexByPath.get(outline.path);
    if (sourceIndex === undefined) {
      continue;
    }
    for (const item of outline.items) {
      if (!item.isImport) {
        continue;
      }
      const targetPath = resolveChangedImport(outline.path, item.name, fileIndexByPath);
      const targetIndex = targetPath === undefined ? undefined : fileIndexByPath.get(targetPath);
      if (targetIndex !== undefined) {
        union(parents, sourceIndex, targetIndex);
      }
    }
  }
}

function resolveChangedImport(
  sourcePath: string,
  rawImport: string,
  fileIndexByPath: ReadonlyMap<string, number>,
): string | undefined {
  const importPath = unquote(rawImport);
  if (!importPath.startsWith(".")) {
    return undefined;
  }
  const resolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourcePath), importPath),
  );
  for (const candidate of importCandidates(resolved)) {
    if (fileIndexByPath.has(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function importCandidates(resolved: string): string[] {
  const extension = path.posix.extname(resolved);
  const base = /\.(?:[cm]?js|jsx)$/.test(extension)
    ? resolved.slice(0, -extension.length)
    : resolved;
  const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
  return [
    resolved,
    ...(extension ? [] : extensions.map((candidate) => `${resolved}${candidate}`)),
    ...extensions.map((candidate) => `${base}${candidate}`),
    ...extensions.map((candidate) => path.posix.join(base, `index${candidate}`)),
  ];
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
