import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { RuntimeLog } from "../shared/logging.js";
import type { DiffManifest } from "../types.js";

export type StructuralDeclaration = {
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
};

export type StructuralFile = {
  path: string;
  language: string;
  imports: string[];
  declarations: StructuralDeclaration[];
};

export type DiffStructuralAnalysis =
  | {
      available: true;
      version: string;
      headFiles: StructuralFile[];
      baseFiles: StructuralFile[];
      diagnostics: StructuralAnalysisDiagnostics;
    }
  | {
      available: false;
      reason: StructuralAnalysisUnavailableReason;
      diagnostics: StructuralAnalysisDiagnostics;
    };

export type StructuralAnalysisUnavailableReason =
  | "missing-executable"
  | "timeout"
  | "output-limit"
  | "nonzero-exit"
  | "invalid-output"
  | "head-content-unavailable"
  | "base-content-unavailable";

export type DiffStructuralAnalysisLoader = () => Promise<DiffStructuralAnalysis>;

type StructuralAnalysisDiagnostics = {
  durationMs: number;
  fileCount: number;
  declarationCount: number;
};

type ProcessResult = {
  stdout: string;
  stdoutBytes: number;
  stderr: string;
  exitCode: number;
};

type StructuralExecutionLimits = {
  timeoutMs: number;
  stdoutLimitBytes: number;
  stderrLimitBytes: number;
};

type RefSnapshotBudget = {
  remainingBytes: number;
  remainingFiles: number;
};

const sourcePositionSchema = z.object({
  line: z.number().int().nonnegative(),
  column: z.number().int().nonnegative(),
});
const sourceRangeSchema = z.object({
  start: sourcePositionSchema,
  end: sourcePositionSchema,
});
const outlineMemberSchema = z.looseObject({
  role: z.literal("member"),
  symbolType: z.string().min(1),
  name: z.string().min(1),
  range: sourceRangeSchema,
});
const outlineItemSchema = z.looseObject({
  role: z.literal("item"),
  symbolType: z.string().min(1),
  name: z.string().min(1),
  range: sourceRangeSchema,
  isImport: z.boolean(),
  isExported: z.boolean(),
  members: z.array(outlineMemberSchema).optional(),
});
const outlineFileSchema = z.looseObject({
  path: z.string().min(1),
  language: z.string().min(1),
  items: z.array(outlineItemSchema),
});
const outlineOutputSchema = z.array(outlineFileSchema);

const outlineTimeoutMs = 30_000;
const outlineStdoutLimitBytes = 16 * 1024 * 1024;
const outlineStderrLimitBytes = 1024 * 1024;
const versionOutputLimitBytes = 1024;
const refSnapshotMaxFiles = 512;

class StructuralAnalysisError extends Error {
  constructor(readonly reason: StructuralAnalysisUnavailableReason) {
    super(reason);
  }
}

export async function analyzeDiffStructure(options: {
  manifest: DiffManifest;
  workspace: string;
  headRef?: string;
  env?: NodeJS.ProcessEnv;
  log?: RuntimeLog;
  executionLimits?: Partial<StructuralExecutionLimits>;
}): Promise<DiffStructuralAnalysis> {
  const started = Date.now();
  const limits = {
    timeoutMs: outlineTimeoutMs,
    stdoutLimitBytes: outlineStdoutLimitBytes,
    stderrLimitBytes: outlineStderrLimitBytes,
    ...options.executionLimits,
  };
  try {
    const version = await loadAstGrepVersion(options.env, limits);
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-ast-grep-"));
    try {
      const configPath = path.join(temporaryRoot, "sgconfig.yml");
      await Bun.write(configPath, "{}\n");
      const snapshotBudget: RefSnapshotBudget = {
        remainingBytes: limits.stdoutLimitBytes,
        remainingFiles: refSnapshotMaxFiles,
      };
      const headPaths = currentManifestPaths(options.manifest);
      const headFiles =
        headPaths.length === 0
          ? []
          : options.headRef
            ? await loadRefOutlines({
                workspace: options.workspace,
                root: path.join(temporaryRoot, "head"),
                ref: options.headRef,
                side: "head",
                paths: headPaths,
                configPath,
                env: options.env,
                limits,
                snapshotBudget,
              })
            : await loadOutlines({
                cwd: options.workspace,
                paths: headPaths,
                configPath,
                env: options.env,
                limits,
              });
      const basePaths = baseManifestPaths(options.manifest);
      const baseFiles =
        basePaths.length === 0
          ? []
          : await loadRefOutlines({
              workspace: options.workspace,
              root: path.join(temporaryRoot, "base"),
              ref: options.manifest.mergeBaseSha,
              side: "base",
              paths: basePaths,
              configPath,
              env: options.env,
              limits,
              snapshotBudget,
            });
      const diagnostics = analysisDiagnostics(started, headFiles, baseFiles);
      options.log?.info("diff structural analysis", {
        status: "available",
        version,
        ...diagnostics,
      });
      return { available: true, version, headFiles, baseFiles, diagnostics };
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  } catch (error) {
    const reason = unavailableReason(error);
    const diagnostics = analysisDiagnostics(started, [], []);
    options.log?.warning("diff structural analysis", {
      status: "unavailable",
      reason,
      ...diagnostics,
    });
    return { available: false, reason, diagnostics };
  }
}

export function createDiffStructuralAnalysisLoader(
  options: Parameters<typeof analyzeDiffStructure>[0],
): DiffStructuralAnalysisLoader {
  let analysis: Promise<DiffStructuralAnalysis> | undefined;
  return () => {
    analysis ??= analyzeDiffStructure(options);
    return analysis;
  };
}

async function loadAstGrepVersion(
  env: NodeJS.ProcessEnv | undefined,
  limits: StructuralExecutionLimits,
): Promise<string> {
  const result = await runBoundedProcess(["ast-grep", "--version"], {
    env,
    timeoutMs: limits.timeoutMs,
    stdoutLimitBytes: versionOutputLimitBytes,
    stderrLimitBytes: limits.stderrLimitBytes,
  });
  if (result.exitCode !== 0) {
    throw new StructuralAnalysisError("nonzero-exit");
  }
  const match = /^ast-grep\s+(\S+)\s*$/.exec(result.stdout);
  if (!match?.[1]) {
    throw new StructuralAnalysisError("invalid-output");
  }
  return match[1];
}

async function loadOutlines(options: {
  cwd: string;
  paths: string[];
  configPath: string;
  env: NodeJS.ProcessEnv | undefined;
  limits: StructuralExecutionLimits;
}): Promise<StructuralFile[]> {
  const result = await runBoundedProcess(
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
      options.configPath,
      "--",
      ...options.paths,
    ],
    {
      cwd: options.cwd,
      env: options.env,
      timeoutMs: options.limits.timeoutMs,
      stdoutLimitBytes: options.limits.stdoutLimitBytes,
      stderrLimitBytes: options.limits.stderrLimitBytes,
    },
  );
  if (result.exitCode !== 0) {
    throw new StructuralAnalysisError("nonzero-exit");
  }
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    throw new StructuralAnalysisError("invalid-output");
  }
  const parsed = outlineOutputSchema.safeParse(json);
  if (!parsed.success) {
    throw new StructuralAnalysisError("invalid-output");
  }
  return parsed.data.map(normalizeOutlineFile);
}

async function loadRefOutlines(options: {
  workspace: string;
  root: string;
  ref: string;
  side: "base" | "head";
  paths: string[];
  configPath: string;
  env: NodeJS.ProcessEnv | undefined;
  limits: StructuralExecutionLimits;
  snapshotBudget: RefSnapshotBudget;
}): Promise<StructuralFile[]> {
  if (options.paths.length > options.snapshotBudget.remainingFiles) {
    throw new StructuralAnalysisError("output-limit");
  }
  await mkdir(options.root, { recursive: true });
  for (const filePath of options.paths) {
    const result = await runBoundedProcess(["git", "show", `${options.ref}:${filePath}`], {
      cwd: options.workspace,
      env: options.env,
      timeoutMs: options.limits.timeoutMs,
      stdoutLimitBytes: options.snapshotBudget.remainingBytes,
      stderrLimitBytes: options.limits.stderrLimitBytes,
    });
    if (result.exitCode !== 0) {
      throw new StructuralAnalysisError(
        options.side === "head" ? "head-content-unavailable" : "base-content-unavailable",
      );
    }
    options.snapshotBudget.remainingBytes -= result.stdoutBytes;
    options.snapshotBudget.remainingFiles -= 1;
    const target = path.join(options.root, filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, result.stdout);
  }
  return await loadOutlines({
    cwd: options.root,
    paths: options.paths,
    configPath: options.configPath,
    env: options.env,
    limits: options.limits,
  });
}

function normalizeOutlineFile(file: z.infer<typeof outlineFileSchema>): StructuralFile {
  const declarations: StructuralDeclaration[] = [];
  const imports: string[] = [];
  for (const item of file.items) {
    if (item.isImport) {
      imports.push(unquote(item.name));
      continue;
    }
    declarations.push(normalizeDeclaration(item, item.name, item.isExported));
    for (const member of item.members ?? []) {
      declarations.push(normalizeDeclaration(member, `${item.name}.${member.name}`, false));
    }
  }
  return {
    path: normalizeRelativePath(file.path),
    language: file.language,
    imports,
    declarations,
  };
}

function normalizeDeclaration(
  item: Pick<z.infer<typeof outlineItemSchema>, "symbolType" | "range">,
  qualifiedName: string,
  isExported: boolean,
): StructuralDeclaration {
  return {
    qualifiedName,
    kind: item.symbolType,
    startLine: item.range.start.line + 1,
    endLine: item.range.end.line + 1,
    isExported,
  };
}

function currentManifestPaths(manifest: DiffManifest): string[] {
  return uniqueSafePaths(
    manifest.files
      .filter((file) => file.status !== "removed" && file.hunks.length > 0)
      .map((file) => file.path),
  );
}

function baseManifestPaths(manifest: DiffManifest): string[] {
  return uniqueSafePaths(
    manifest.files
      .filter((file) => file.commentableRanges.some((range) => range.side === "LEFT"))
      .map((file) => file.previousPath ?? file.path),
  );
}

function uniqueSafePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeRelativePath))];
}

function normalizeRelativePath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === ".." || part === ".git")
  ) {
    throw new StructuralAnalysisError("invalid-output");
  }
  return normalized;
}

function unquote(value: string): string {
  const first = value[0];
  const last = value.at(-1);
  return first && last && first === last && ['"', "'", "`"].includes(first)
    ? value.slice(1, -1)
    : value;
}

function analysisDiagnostics(
  started: number,
  headFiles: readonly StructuralFile[],
  baseFiles: readonly StructuralFile[],
): StructuralAnalysisDiagnostics {
  const files = [...headFiles, ...baseFiles];
  return {
    durationMs: Date.now() - started,
    fileCount: files.length,
    declarationCount: files.reduce((sum, file) => sum + file.declarations.length, 0),
  };
}

function unavailableReason(error: unknown): StructuralAnalysisUnavailableReason {
  if (error instanceof StructuralAnalysisError) {
    return error.reason;
  }
  if (isMissingExecutableError(error)) {
    return "missing-executable";
  }
  return "invalid-output";
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function runBoundedProcess(
  command: [string, ...string[]],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
    stdoutLimitBytes: number;
    stderrLimitBytes: number;
  },
): Promise<ProcessResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(error);
    };
    const timer = setTimeout(() => fail(new StructuralAnalysisError("timeout")), options.timeoutMs);
    child.on("error", fail);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > options.stdoutLimitBytes) {
        fail(new StructuralAnalysisError("output-limit"));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes > options.stderrLimitBytes) {
        fail(new StructuralAnalysisError("output-limit"));
        return;
      }
      stderr.push(chunk);
    });
    child.on("close", (exitCode) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stdoutBytes,
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: exitCode ?? -1,
      });
    });
  });
}
