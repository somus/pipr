import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { findEnclosingDeclaration } from "../diff/manifest-structure.js";
import { createDiffRangeIndex } from "../diff/ranges.js";
import type { DiffStructuralAnalysis, StructuralDeclaration } from "../diff/structural-analysis.js";
import { isRecord } from "../shared/record.js";
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
  baseDeclarations?: Record<string, BaseDeclarationSnapshot>;
  structuralAnalysis?: Extract<DiffStructuralAnalysis, { available: true }>;
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

export type BaseDeclarationSnapshot = {
  path: string;
  ref: "base";
  sourcePath: string;
  rangeId: string;
  declaration: StructuralDeclaration;
  available: boolean;
  relativePath?: string;
  bytes?: number;
  truncated?: boolean;
};

export type ReadDeclarationParams = {
  path: string;
  ref: "base" | "head";
  rangeId: string;
};

export type AstGrepSearchParams = {
  pattern: string;
  language: string;
  paths: string[];
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
    const record = isRecord(params) ? params : {};
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
  (params) => (isRecord(params) ? params : {}),
  z.object({
    path: z.unknown(),
    ref: z.enum(["base", "head"], {
      error: (issue) => `Unsupported ref '${String(issue.input)}'`,
    }),
    rangeId: z.string({ error: "rangeId must be a string" }),
  }),
);
const astGrepSearchParamsSchema = z.strictObject({
  pattern: z.string().min(1).max(4096),
  language: z.string().min(1).max(64),
  paths: z.array(z.string()).min(1).max(16),
});
const astGrepMatchSchema = z.looseObject({
  text: z.string(),
  file: z.string(),
  range: z.object({
    start: z.object({
      line: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    }),
    end: z.object({
      line: z.number().int().nonnegative(),
      column: z.number().int().nonnegative(),
    }),
  }),
});
const astGrepMatchesSchema = z.array(astGrepMatchSchema);
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

export function readDeclarationParams(params: unknown): ReadDeclarationParams {
  return readAtRefParams(params);
}

export function astGrepSearchParams(params: unknown): AstGrepSearchParams {
  const parsed = astGrepSearchParamsSchema.parse(params);
  return {
    pattern: parsed.pattern,
    language: parsed.language,
    paths: parsed.paths.map(parseSearchPath),
  };
}

export function resolveDeclarationRequest(
  data: RuntimeToolData,
  params: ReadDeclarationParams,
):
  | {
      available: true;
      path: string;
      sourcePath: string;
      ref: "base" | "head";
      rangeId: string;
      declaration: StructuralDeclaration;
    }
  | {
      available: false;
      path: string;
      sourcePath: string;
      ref: "base" | "head";
      rangeId: string;
    } {
  const filePath = parseManifestPath(params.path);
  const ranges = createDiffRangeIndex(data.manifest);
  const file = ranges.requireFile(filePath);
  const range = ranges.requireRangeInFile(file, params.rangeId);
  const sourcePath = parseManifestPath(
    params.ref === "base" ? (file.previousPath ?? file.path) : file.path,
  );
  const expectedSide = params.ref === "base" ? "LEFT" : "RIGHT";
  if (!data.structuralAnalysis || range.side !== expectedSide) {
    return {
      available: false,
      path: file.path,
      sourcePath,
      ref: params.ref,
      rangeId: range.id,
    };
  }
  const owner = findEnclosingDeclaration(file, range, data.structuralAnalysis);
  if (!owner || owner.ref !== params.ref) {
    return {
      available: false,
      path: file.path,
      sourcePath,
      ref: params.ref,
      rangeId: range.id,
    };
  }
  return {
    available: true,
    path: file.path,
    sourcePath: owner.sourcePath,
    ref: params.ref,
    rangeId: range.id,
    declaration: owner.declaration,
  };
}

export async function runAstGrepSearch(options: {
  cwd: string;
  params: AstGrepSearchParams;
  maxBytes: number;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<unknown> {
  for (const searchPath of options.params.paths) {
    if (searchPath !== ".") {
      resolveAllowedPath(options.cwd, searchPath);
      await assertNoSymlinkPath(options.cwd, searchPath);
    }
  }
  const result = await runAstGrepProcess(
    [
      "ast-grep",
      "run",
      "--pattern",
      options.params.pattern,
      "--lang",
      options.params.language,
      "--json=compact",
      "--color",
      "never",
      "--",
      ...options.params.paths,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 10_000,
    },
  );
  const output = result.stdout.trim();
  if (result.exitCode === 1 && (output === "" || output === "[]")) {
    return assertSerializedToolResponseFits(
      { available: true, matches: [], truncated: false },
      options.maxBytes,
      "pipr_ast_grep response limit is too small",
    );
  }
  if (result.exitCode !== 0) {
    throw new Error("pipr_ast_grep failed");
  }
  let json: unknown;
  try {
    json = JSON.parse(output);
  } catch {
    throw new Error("pipr_ast_grep returned invalid output");
  }
  const parsed = astGrepMatchesSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("pipr_ast_grep returned invalid output");
  }
  const matches: Array<{
    path: string;
    startLine: number;
    endLine: number;
    text: string;
  }> = [];
  let truncated = parsed.data.length > 100;
  for (const match of parsed.data.slice(0, 100)) {
    const normalized = {
      path: parseSearchResultPath(match.file),
      startLine: match.range.start.line + 1,
      endLine: match.range.end.line + 1,
      text: truncateUtf8(match.text, 2 * 1024),
    };
    const candidate = { available: true, matches: [...matches, normalized], truncated };
    if (serializedToolResponseBytes(candidate) > options.maxBytes) {
      truncated = true;
      break;
    }
    matches.push(normalized);
  }
  return assertSerializedToolResponseFits(
    { available: true, matches, truncated },
    options.maxBytes,
    "pipr_ast_grep response limit is too small",
  );
}

function serializedToolResponseBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function assertSerializedToolResponseFits<T>(
  value: T,
  maxBytes: number,
  errorMessage: string,
): T {
  if (serializedToolResponseBytes(value) > maxBytes) {
    throw new Error(errorMessage);
  }
  return value;
}

export function boundToolResponseContent<T extends { content: string }>(
  value: T,
  maxBytes: number,
  errorMessage: string,
): T & { truncated: boolean } {
  if (serializedToolResponseBytes(value) <= maxBytes) {
    return value as T & { truncated: boolean };
  }
  const empty = { ...value, content: "", truncated: true };
  assertSerializedToolResponseFits(empty, maxBytes, errorMessage);
  const originalBuffer = Buffer.from(value.content, "utf8");
  let low = 0;
  let high = originalBuffer.byteLength;
  let best = empty;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = {
      ...value,
      content: originalBuffer.subarray(0, middle).toString("utf8"),
      truncated: true,
    };
    if (serializedToolResponseBytes(candidate) <= maxBytes) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
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

function parseSearchPath(value: string): string {
  if (value === ".") {
    return value;
  }
  if (
    value.includes("\\") ||
    /[*?[\]{}]/.test(value) ||
    path.isAbsolute(value) ||
    value.includes("\0") ||
    value.split("/").some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new Error(`Unsafe structural search path '${value}'`);
  }
  return value;
}

function parseSearchResultPath(value: string): string {
  try {
    return parseSearchPath(value);
  } catch {
    throw new Error("pipr_ast_grep returned an unsafe path");
  }
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  return buffer.byteLength <= maxBytes ? value : buffer.subarray(0, maxBytes).toString("utf8");
}

async function runAstGrepProcess(
  command: [string, ...string[]],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  },
): Promise<{ stdout: string; exitCode: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (message: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(message));
    };
    const timer = setTimeout(() => fail("pipr_ast_grep timed out"), options.timeoutMs);
    child.on("error", () => fail("pipr_ast_grep is unavailable"));
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > 16 * 1024 * 1024) {
        fail("pipr_ast_grep exceeded its output limit");
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > 1024 * 1024) {
        fail("pipr_ast_grep exceeded its output limit");
      }
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        exitCode: exitCode ?? -1,
      });
    });
  });
}
