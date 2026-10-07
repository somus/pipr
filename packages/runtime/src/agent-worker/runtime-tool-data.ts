import path from "node:path";
import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type { DiffStructuralAnalysis, StructuralDeclaration } from "../diff/structural-analysis.js";
import {
  type CommentableRange,
  type DiffHunk,
  type DiffManifest,
  type DiffManifestFile,
  diffManifestSchema,
} from "../types.js";

/**
 * Runtime tool data contract: the supervisor writes this file before a run and the worker's Diff Manifest read tools
 * parse it. Both sides share the range resolution and line slicing below so snapshots and live reads agree.
 */

const readAtRefContextLines = 3;

const refSchema = z.enum(["base", "head"]);

const structuralDeclarationSchema: z.ZodType<StructuralDeclaration> = z.object({
  qualifiedName: z.string(),
  kind: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  isExported: z.boolean(),
});

const structuralFileSchema = z.object({
  path: z.string(),
  language: z.string(),
  imports: z.array(z.string()),
  declarations: z.array(structuralDeclarationSchema),
});

const structuralAnalysisSchema: z.ZodType<Extract<DiffStructuralAnalysis, { available: true }>> =
  z.object({
    available: z.literal(true),
    version: z.string(),
    headFiles: z.array(structuralFileSchema),
    baseFiles: z.array(structuralFileSchema),
    diagnostics: z.object({
      durationMs: z.number(),
      fileCount: z.number(),
      declarationCount: z.number(),
    }),
  });

const snapshotFileFields = {
  relativePath: z.string(),
  bytes: z.number(),
  truncated: z.boolean(),
};

const baseRangeFields = {
  path: z.string(),
  ref: refSchema,
  sourcePath: z.string(),
  rangeId: z.string(),
  startLine: z.number(),
  endLine: z.number(),
};

const baseRangeSnapshotSchema = z.discriminatedUnion("available", [
  z.object({ ...baseRangeFields, available: z.literal(true), ...snapshotFileFields }),
  z.object({ ...baseRangeFields, available: z.literal(false) }),
]);

const baseDeclarationSnapshotSchema = z.object({
  path: z.string(),
  ref: z.literal("base"),
  sourcePath: z.string(),
  rangeId: z.string(),
  declaration: structuralDeclarationSchema,
  available: z.literal(true),
  ...snapshotFileFields,
});

const runtimeToolDataSchema = z.object({
  manifest: diffManifestSchema,
  toolResponseMaxBytes: z.number().int().positive(),
  baseRanges: z.record(z.string(), baseRangeSnapshotSchema),
  baseDeclarations: z.record(z.string(), baseDeclarationSnapshotSchema).optional(),
  structuralAnalysis: structuralAnalysisSchema.optional(),
});

export type RuntimeToolData = z.infer<typeof runtimeToolDataSchema>;
export type BaseRangeSnapshot = z.infer<typeof baseRangeSnapshotSchema>;
export type BaseDeclarationSnapshot = z.infer<typeof baseDeclarationSnapshotSchema>;

export type ReadAtRefParams = {
  path: string;
  ref: "base" | "head";
  rangeId: string;
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

type LineSliceResult = {
  available: true;
  content: string;
  bytes: number;
  truncated: boolean;
};

export async function readRuntimeToolData(dataPath: string): Promise<RuntimeToolData> {
  return runtimeToolDataSchema.parse(await Bun.file(dataPath).json());
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
