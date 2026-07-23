import type { DiffManifestOptions } from "@usepipr/sdk";
import type {
  DiffManifest,
  DiffManifestFile,
  DiffManifestLimitsConfig,
  DiffManifestPromptMetrics,
} from "../types.js";
import { parseDiffManifest } from "../types.js";
import { filterDiffManifestByPaths } from "./path-filter.js";

export type DiffManifestPromptMode = "full" | "condensed";

export type DiffManifestPromptLimits = {
  fullMaxBytes: number;
  fullMaxEstimatedTokens: number;
  condensedMaxBytes: number;
  condensedMaxEstimatedTokens: number;
  toolResponseMaxBytes: number;
};

export type PreparedDiffManifestPrompt = {
  mode: DiffManifestPromptMode;
  manifest: DiffManifest;
  metrics: {
    full: DiffManifestPromptMetrics;
    selected: DiffManifestPromptMetrics;
  };
  limits: DiffManifestPromptLimits;
};

const defaultDiffManifestPromptLimits: DiffManifestPromptLimits = {
  fullMaxBytes: 128 * 1024,
  fullMaxEstimatedTokens: 32_000,
  condensedMaxBytes: 256 * 1024,
  condensedMaxEstimatedTokens: 64_000,
  toolResponseMaxBytes: 64 * 1024,
};

export function projectDiffManifest(
  manifest: DiffManifest,
  options: DiffManifestOptions | undefined,
): DiffManifest {
  if (!manifestOptionsHaveEffect(options)) {
    return manifest;
  }
  const manifestOptions = options ?? {};
  const scopedManifest = filterDiffManifestByPaths(manifest, manifestOptions.paths);
  return parseDiffManifest({
    ...scopedManifest,
    files: scopedManifest.files.map((file) => ({
      ...withoutCompressedFileFields(file, manifestOptions.compressed === true),
      commentableRanges: file.commentableRanges.map((range) => ({
        ...rangeFieldsForOptions(range, manifestOptions),
        ...(manifestOptions.includePreviews === false
          ? {}
          : { preview: truncatePreview(range.preview, manifestOptions.maxPreviewLines) }),
      })),
    })),
  });
}

export function cloneDiffManifest(manifest: DiffManifest): DiffManifest {
  return parseDiffManifest(structuredClone(manifest));
}

export function prepareDiffManifestPrompt(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
  options: { allowOversizedCondensed?: boolean } = {},
): PreparedDiffManifestPrompt {
  const limits = resolveDiffManifestPromptLimits(config);
  const full = measureDiffManifestPrompt(manifest);
  if (fitsLimit(full, limits.fullMaxBytes, limits.fullMaxEstimatedTokens)) {
    return { mode: "full", manifest, metrics: { full, selected: full }, limits };
  }

  const condensedManifest = condenseDiffManifest(manifest);
  const condensed = measureDiffManifestPrompt(condensedManifest);
  if (
    !options.allowOversizedCondensed &&
    !fitsLimit(condensed, limits.condensedMaxBytes, limits.condensedMaxEstimatedTokens)
  ) {
    throw new Error(
      [
        "Diff Manifest payload exceeds condensed limit before Pi execution",
        `selected=${condensed.bytes} bytes/${condensed.estimatedTokens} estimated tokens`,
        `limit=${limits.condensedMaxBytes} bytes/${limits.condensedMaxEstimatedTokens} estimated tokens`,
      ].join("; "),
    );
  }

  return {
    mode: "condensed",
    manifest: condensedManifest,
    metrics: { full, selected: condensed },
    limits,
  };
}

export function partitionDiffManifestForPrompt(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
): DiffManifest[] {
  if (diffManifestFitsPrompt(manifest, config)) {
    return [manifest];
  }
  if (manifest.files.length === 0) {
    return [manifest];
  }

  const units: DiffManifest[] = [];
  let files: DiffManifestFile[] = [];
  for (const file of manifest.files) {
    const singleFileManifest = manifestWithFiles(manifest, [file]);
    if (!diffManifestFitsPrompt(singleFileManifest, config)) {
      if (files.length > 0) {
        units.push(manifestWithFiles(manifest, files));
        files = [];
      }
      units.push(...splitOversizedManifestFile(manifest, file, config));
      continue;
    }

    const candidateFiles = [...files, file];
    if (
      files.length > 0 &&
      !diffManifestFitsPrompt(manifestWithFiles(manifest, candidateFiles), config)
    ) {
      units.push(manifestWithFiles(manifest, files));
      files = [file];
    } else {
      files = candidateFiles;
    }
  }
  if (files.length > 0) {
    units.push(manifestWithFiles(manifest, files));
  }
  return units;
}

export function condenseDiffManifest(manifest: DiffManifest): DiffManifest {
  return {
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    mergeBaseSha: manifest.mergeBaseSha,
    files: manifest.files.map(condenseDiffManifestFile),
  };
}

export function measureDiffManifestPrompt(manifest: DiffManifest): DiffManifestPromptMetrics {
  const json = JSON.stringify(manifest, null, 2);
  const bytes = Buffer.byteLength(json, "utf8");
  return {
    bytes,
    estimatedTokens: Math.ceil(bytes / 4),
  };
}

function resolveDiffManifestPromptLimits(
  config: DiffManifestLimitsConfig | undefined,
): DiffManifestPromptLimits {
  const { maxShards: _maxShards, ...promptLimits } = config ?? {};
  return {
    ...defaultDiffManifestPromptLimits,
    ...Object.fromEntries(Object.entries(promptLimits).filter((entry) => entry[1] !== undefined)),
  };
}

function manifestOptionsHaveEffect(options: DiffManifestOptions | undefined): boolean {
  return Boolean(
    options?.compressed ||
      options?.includePreviews === false ||
      options?.maxPreviewLines !== undefined ||
      options?.paths,
  );
}

function withoutCompressedFileFields(
  file: DiffManifest["files"][number],
  compressed: boolean,
): DiffManifest["files"][number] {
  if (!compressed) {
    return file;
  }
  const { signals: _signals, changedSymbols: _changedSymbols, ...rest } = file;
  return rest;
}

function withoutCompressedRangeFields(
  range: DiffManifest["files"][number]["commentableRanges"][number],
  compressed: boolean,
) {
  if (!compressed) {
    return range;
  }
  const { summary: _summary, ...rest } = range;
  return rest;
}

function rangeFieldsForOptions(
  range: DiffManifest["files"][number]["commentableRanges"][number],
  options: DiffManifestOptions,
): DiffManifest["files"][number]["commentableRanges"][number] {
  const fields = withoutCompressedRangeFields(range, options.compressed === true);
  if (options.includePreviews === false) {
    const { preview: _preview, ...rest } = fields;
    return rest;
  }
  return fields;
}

function truncatePreview(
  preview: string | undefined,
  maxLines: number | undefined,
): string | undefined {
  if (preview === undefined || maxLines === undefined) {
    return preview;
  }
  return preview.split("\n").slice(0, maxLines).join("\n");
}

function condenseDiffManifestFile(file: DiffManifestFile): DiffManifestFile {
  return {
    path: file.path,
    previousPath: file.previousPath,
    status: file.status,
    language: file.language,
    additions: file.additions,
    deletions: file.deletions,
    hunks: file.hunks.map((hunk) => ({
      hunkIndex: hunk.hunkIndex,
      header: hunk.header,
      oldStart: hunk.oldStart,
      oldLines: hunk.oldLines,
      newStart: hunk.newStart,
      newLines: hunk.newLines,
      contentHash: hunk.contentHash,
    })),
    commentableRanges: file.commentableRanges.map((range) => ({
      id: range.id,
      path: range.path,
      side: range.side,
      startLine: range.startLine,
      endLine: range.endLine,
      kind: range.kind,
      hunkIndex: range.hunkIndex,
      hunkHeader: range.hunkHeader,
      hunkContentHash: range.hunkContentHash,
    })),
    excludedReason: file.excludedReason,
  };
}

function splitOversizedManifestFile(
  manifest: DiffManifest,
  file: DiffManifestFile,
  config: DiffManifestLimitsConfig | undefined,
): DiffManifest[] {
  if (file.hunks.length === 0) {
    return [ensureManifestFitsPrompt(manifestWithFiles(manifest, [file]), config)];
  }

  const rangesByHunk = new Map<number, DiffManifestFile["commentableRanges"][number][]>();
  for (const range of file.commentableRanges) {
    const ranges = rangesByHunk.get(range.hunkIndex) ?? [];
    ranges.push(range);
    rangesByHunk.set(range.hunkIndex, ranges);
  }
  return file.hunks.flatMap((hunk) =>
    splitManifestHunk(manifest, file, hunk, rangesByHunk.get(hunk.hunkIndex) ?? [], config),
  );
}

function splitManifestHunk(
  manifest: DiffManifest,
  file: DiffManifestFile,
  hunk: DiffManifestFile["hunks"][number],
  ranges: DiffManifestFile["commentableRanges"],
  config: DiffManifestLimitsConfig | undefined,
): DiffManifest[] {
  if (ranges.length === 0) {
    return [ensureManifestFitsPrompt(manifestWithFileSlice(manifest, file, [hunk], []), config)];
  }

  const units: DiffManifest[] = [];
  let selectedRanges: DiffManifestFile["commentableRanges"] = [];
  for (const range of ranges) {
    const candidateRanges = [...selectedRanges, range];
    const candidate = manifestWithFileSlice(manifest, file, [hunk], candidateRanges);
    if (selectedRanges.length > 0 && !diffManifestFitsPrompt(candidate, config)) {
      units.push(
        ensureManifestFitsPrompt(
          manifestWithFileSlice(manifest, file, [hunk], selectedRanges),
          config,
        ),
      );
      selectedRanges = [range];
      continue;
    }
    selectedRanges = candidateRanges;
  }
  units.push(
    ensureManifestFitsPrompt(manifestWithFileSlice(manifest, file, [hunk], selectedRanges), config),
  );
  return units;
}

function manifestWithFileSlice(
  manifest: DiffManifest,
  file: DiffManifestFile,
  hunks: DiffManifestFile["hunks"],
  commentableRanges: DiffManifestFile["commentableRanges"],
): DiffManifest {
  return manifestWithFiles(manifest, [{ ...file, hunks, commentableRanges }]);
}

function manifestWithFiles(
  manifest: DiffManifest,
  files: readonly DiffManifestFile[],
): DiffManifest {
  return { ...manifest, files };
}

function ensureManifestFitsPrompt(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
): DiffManifest {
  prepareDiffManifestPrompt(manifest, config);
  return manifest;
}

function diffManifestFitsPrompt(
  manifest: DiffManifest,
  config: DiffManifestLimitsConfig | undefined,
): boolean {
  const limits = resolveDiffManifestPromptLimits(config);
  const full = measureDiffManifestPrompt(manifest);
  if (fitsLimit(full, limits.fullMaxBytes, limits.fullMaxEstimatedTokens)) {
    return true;
  }
  const condensed = measureDiffManifestPrompt(condenseDiffManifest(manifest));
  return fitsLimit(condensed, limits.condensedMaxBytes, limits.condensedMaxEstimatedTokens);
}

function fitsLimit(
  metrics: DiffManifestPromptMetrics,
  maxBytes: number,
  maxEstimatedTokens: number,
): boolean {
  return metrics.bytes <= maxBytes && metrics.estimatedTokens <= maxEstimatedTokens;
}
