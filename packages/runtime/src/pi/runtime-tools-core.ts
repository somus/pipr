import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type { CommentableRange, DiffHunk, DiffManifest, DiffManifestFile } from "../types.js";

const readAtRefContextLines = 3;

export type ReadDiffParams = {
  path?: string;
  rangeId?: string;
};

export type ReadAtRefParams = {
  path: string;
  ref: "base" | "head";
  rangeId: string;
};

export type RuntimeToolData = {
  manifest: DiffManifest;
  toolResponseMaxBytes: number;
  baseRanges: Record<string, BaseRangeSnapshot>;
};

export type BaseRangeSnapshot = {
  path: string;
  ref: "base" | "head";
  sourcePath: string;
  rangeId: string;
  startLine: number;
  endLine: number;
  available: boolean;
  relativePath?: string;
  bytes?: number;
  truncated?: boolean;
};

export type ReadAtRefRequest = {
  file: DiffManifestFile;
  range: CommentableRange;
  hunk: DiffHunk;
  ref: "base" | "head";
  sourcePath: string;
  window: LineWindow | undefined;
};

export type LineWindow = {
  startLine: number;
  endLine: number;
};

export type LineSliceResult = {
  available: true;
  content: string;
  bytes: number;
  truncated: boolean;
};

const readDiffParamsSchema = z.preprocess(
  (params) => {
    const record =
      typeof params === "object" && params !== null && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    return {
      path: typeof record.path === "string" ? record.path : undefined,
      rangeId: typeof record.rangeId === "string" ? record.rangeId : undefined,
    };
  },
  z.object({
    path: z.string().optional(),
    rangeId: z.string().optional(),
  }),
);

const readAtRefParamsSchema = z.preprocess(
  (params) =>
    typeof params === "object" && params !== null && !Array.isArray(params) ? params : {},
  z.object({
    path: z.unknown(),
    ref: z.enum(["base", "head"], {
      error: (issue) => `Unsupported ref '${String(issue.input)}'`,
    }),
    rangeId: z.string({ error: "rangeId must be a string" }),
  }),
);

export function readDiffFromRuntimeData(data: RuntimeToolData, params: ReadDiffParams): unknown {
  const { rangeId } = params;
  const filePath = params.path === undefined ? undefined : parseManifestPath(params.path);
  const ranges = createDiffRangeIndex(data.manifest);
  if (filePath !== undefined) {
    ranges.requireFile(filePath);
  }
  if (rangeId !== undefined && !ranges.findRange(rangeId)) {
    throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
  }
  const files = data.manifest.files
    .filter((file) => filePath === undefined || file.path === filePath)
    .map((file) => filterManifestFileRanges(file, rangeId))
    .filter((file) => rangeId === undefined || file.commentableRanges.length > 0);
  return boundedJson({ files }, data.toolResponseMaxBytes);
}

function boundedJson(value: unknown, maxBytes: number): unknown {
  const text = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) {
    return { truncated: false, bytes, value };
  }
  return {
    truncated: true,
    bytes,
    maxBytes,
    text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"),
  };
}

export function boundedLineSlice(
  content: string,
  window: LineWindow,
  maxBytes: number,
): LineSliceResult {
  const lines = content.match(/[^\n]*(?:\n|$)/g) ?? [];
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const slice = lines.slice(window.startLine - 1, window.endLine).join("");
  const buffer = Buffer.from(slice, "utf8");
  return {
    available: true,
    content: buffer.subarray(0, maxBytes).toString("utf8"),
    bytes: buffer.byteLength,
    truncated: buffer.byteLength > maxBytes,
  };
}

export function resolveReadAtRefRequest(
  manifest: DiffManifest,
  params: ReadAtRefParams,
): ReadAtRefRequest {
  const filePath = parseManifestPath(params.path);
  const ranges = createDiffRangeIndex(manifest);
  const file = ranges.requireFile(filePath);
  const range = ranges.requireRangeInFile(file, params.rangeId);
  const hunk = ranges.requireHunk(file, range);
  const sourcePath = parseManifestPath(
    params.ref === "base" ? (file.previousPath ?? file.path) : file.path,
  );
  return {
    file,
    range,
    hunk,
    ref: params.ref,
    sourcePath,
    window: lineWindowForRange(range, hunk, params.ref),
  };
}

export function unavailableReadAtRefResult(request: ReadAtRefRequest): BaseRangeSnapshot {
  return {
    path: request.file.path,
    ref: request.ref,
    sourcePath: request.sourcePath,
    rangeId: request.range.id,
    startLine: 0,
    endLine: 0,
    available: false,
  };
}

export function parseManifestPath(filePath: unknown): string {
  if (
    typeof filePath !== "string" ||
    filePath.length === 0 ||
    filePath.includes("\0") ||
    path.isAbsolute(filePath) ||
    filePath.split(/[\\/]/).some((part) => part === ".." || part === ".git" || part === "")
  ) {
    throw new Error(`Unsafe manifest path '${String(filePath)}'`);
  }
  return filePath;
}

export function resolveAllowedPath(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${filePath}' resolves outside the workspace`);
  }
  return resolved;
}

export async function assertNoSymlinkPath(root: string, filePath: string): Promise<void> {
  const parts = filePath.split(/[\\/]/);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Path '${filePath}' crosses a symlink`);
    }
  }
}

export function readDiffParams(params: unknown): ReadDiffParams {
  return readDiffParamsSchema.parse(params);
}

export function readAtRefParams(params: unknown): ReadAtRefParams {
  const parsed = readAtRefParamsSchema.parse(params);
  return { path: parseManifestPath(parsed.path), ref: parsed.ref, rangeId: parsed.rangeId };
}

function filterManifestFileRanges(
  file: DiffManifestFile,
  rangeId: string | undefined,
): DiffManifestFile {
  if (rangeId === undefined) {
    return file;
  }
  return {
    ...file,
    commentableRanges: file.commentableRanges.filter((range) => range.id === rangeId),
  };
}

function lineWindowForRange(
  range: CommentableRange,
  hunk: DiffHunk,
  ref: "base" | "head",
): LineWindow | undefined {
  const targetSide: CommentableRange["side"] = ref === "base" ? "LEFT" : "RIGHT";
  if (range.side !== targetSide) {
    return undefined;
  }
  const hunkStart = ref === "base" ? hunk.oldStart : hunk.newStart;
  const hunkLines = ref === "base" ? hunk.oldLines : hunk.newLines;
  if (hunkLines === 0) {
    return undefined;
  }
  const hunkEnd = hunkStart + hunkLines - 1;
  return {
    startLine: Math.max(hunkStart, range.startLine - readAtRefContextLines),
    endLine: Math.min(hunkEnd, range.endLine + readAtRefContextLines),
  };
}
