import path from "node:path";
import type {
  CommentableRange,
  DiffHunk,
  DiffManifest,
  DiffManifestFile,
  FileStatus,
} from "../types.js";
import { parseDiffManifest } from "../types.js";
import { GitOutputLimitError, runGit } from "./git.js";
import { parseUnifiedDiff } from "./unified-diff.js";

type DiffFile = Omit<DiffManifestFile, "hunks" | "commentableRanges"> & {
  hunks: DiffHunk[];
  commentableRanges: CommentableRange[];
};
type DiffStat = {
  additions: number;
  deletions: number;
  excludedReason?: string;
};

const lockFilePattern =
  /(^|\/)(bun\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock)$/;
const generatedPattern = /(^|\/)(dist|build|coverage|vendor)\//;
const maxInlineChangedLines = 1000;
const maxCommentableRangeLines = 5000;
const maxAggregatePatchBytes = 16 * 1024 * 1024;

export type BuildDiffManifestOptions = {
  cwd: string;
  baseSha: string;
  headSha: string;
  includeWorkingTree?: boolean;
  env?: NodeJS.ProcessEnv;
};

type Git = (args: string[], maxBuffer?: number) => string;

export function buildDiffManifest(options: BuildDiffManifestOptions): DiffManifest {
  const git: Git = (args, maxBuffer) => runGit(args, options.cwd, { maxBuffer, env: options.env });
  const mergeBaseSha = git(["merge-base", options.baseSha, options.headSha]).trim();
  const diffHead = options.includeWorkingTree ? undefined : options.headSha;
  const nameStatus = git(
    buildDiffArgs(["--name-status", "-z", "--find-renames"], mergeBaseSha, diffHead),
  );
  const files = parseNameStatus(nameStatus);
  const diffStats = getDiffStats(git, mergeBaseSha, diffHead);
  const preExcludedFiles = getPreExcludedFiles(files, diffStats);
  const rawPatch = loadRawPatch(
    buildUnifiedDiffArgs(mergeBaseSha, diffHead, preExcludedFiles),
    git,
  );

  const parsedDiff = parseUnifiedDiff(rawPatch.patch, rawPatch.filePaths);
  for (const file of files) {
    const stats = diffStats.get(file.path);
    file.additions = stats?.additions ?? 0;
    file.deletions = stats?.deletions ?? 0;
    const preExcludedReason = stats?.excludedReason;
    const parsedFile = parsedDiff.get(file.path);
    file.hunks = preExcludedReason ? [] : (parsedFile?.hunks ?? []);
    file.commentableRanges = preExcludedReason ? [] : (parsedFile?.commentableRanges ?? []);
    const excludedReason = preExcludedReason ?? getExcludedReason(file);
    if (excludedReason) {
      file.hunks = [];
      file.commentableRanges = [];
      file.excludedReason = excludedReason;
    }
  }

  return parseDiffManifest({
    baseSha: options.baseSha,
    headSha: options.headSha,
    mergeBaseSha,
    files,
  });
}

function loadRawPatch(args: string[], git: Git): ReturnType<typeof parseRawPatch> {
  try {
    return parseRawPatch(git(args, maxAggregatePatchBytes));
  } catch (error) {
    if (error instanceof GitOutputLimitError) {
      throw new Error(
        `Diff Manifest construction exceeded aggregate patch limit before parsing; limit=${error.limitBytes} bytes`,
      );
    }
    throw error;
  }
}

function parseNameStatus(output: string): DiffFile[] {
  const fields = output.split("\0");
  const files: DiffFile[] = [];
  let index = 0;
  while (index < fields.length) {
    const rawStatus = fields[index++];
    if (!rawStatus) {
      continue;
    }
    const firstPath = fields[index++] ?? "";
    const status = parseFileStatus(rawStatus);
    if (status === "renamed") {
      const secondPath = fields[index++] ?? "";
      files.push(baseFile(secondPath || firstPath, status, firstPath));
      continue;
    }
    files.push(baseFile(firstPath, status));
  }
  return files;
}

function getDiffStats(
  git: Git,
  baseSha: string,
  headSha: string | undefined,
): Map<string, DiffStat> {
  const output = git(buildDiffArgs(["--numstat", "-z", "--find-renames"], baseSha, headSha));
  const stats = new Map<string, DiffStat>();
  for (const stat of parseNumstat(output)) {
    if (stat.binary) {
      stats.set(stat.path, { additions: 0, deletions: 0, excludedReason: "binary diff" });
      continue;
    }
    stats.set(stat.path, {
      additions: stat.additions,
      deletions: stat.deletions,
      excludedReason:
        stat.additions + stat.deletions > maxInlineChangedLines ? "oversized diff" : undefined,
    });
  }
  return stats;
}

function getPreExcludedFiles(
  files: readonly DiffFile[],
  stats: Map<string, DiffStat>,
): Map<string, string> {
  const excluded = new Map<string, string>();
  for (const [filePath, stat] of stats) {
    if (stat.excludedReason) {
      excluded.set(filePath, stat.excludedReason);
    }
  }
  for (const file of files) {
    const excludedReason = excluded.get(file.path) ?? getPathExcludedReason(file);
    if (!excludedReason) {
      continue;
    }
    excluded.set(file.path, excludedReason);
    if (file.previousPath) {
      excluded.set(file.previousPath, excludedReason);
    }
  }
  return excluded;
}

function buildUnifiedDiffArgs(
  baseSha: string,
  headSha: string | undefined,
  excludedFiles: Map<string, string>,
): string[] {
  const args = buildDiffArgs(
    ["--raw", "-z", "--patch", "--submodule=short", "--unified=80", "--find-renames"],
    baseSha,
    headSha,
  );
  if (excludedFiles.size === 0) {
    return args;
  }
  return [
    ...args,
    "--",
    ".",
    ...[...excludedFiles.keys()].map((filePath) => `:(exclude,literal)${filePath}`),
  ];
}

function buildDiffArgs(options: string[], baseSha: string, headSha: string | undefined): string[] {
  return headSha ? ["diff", ...options, baseSha, headSha] : ["diff", ...options, baseSha];
}

function parseNumstat(
  output: string,
): Array<{ path: string; additions: number; deletions: number; binary: boolean }> {
  const fields = output.split("\0");
  const stats: Array<{ path: string; additions: number; deletions: number; binary: boolean }> = [];
  let index = 0;
  while (index < fields.length) {
    const header = parseNumstatHeader(fields[index++] ?? "");
    if (!header) {
      continue;
    }
    const resolvedPath = resolveNumstatPath(header.path, fields, index);
    index = resolvedPath.nextIndex;
    const filePath = resolvedPath.path;
    if (!filePath) {
      continue;
    }
    const binary = header.rawAdditions === "-" || header.rawDeletions === "-";
    stats.push({
      path: filePath,
      additions: binary ? 0 : Number(header.rawAdditions),
      deletions: binary ? 0 : Number(header.rawDeletions),
      binary,
    });
  }
  return stats;
}

function resolveNumstatPath(
  path: string,
  fields: readonly string[],
  nextIndex: number,
): { path: string; nextIndex: number } {
  if (path) {
    return { path, nextIndex };
  }
  return { path: fields[nextIndex + 1] ?? "", nextIndex: nextIndex + 2 };
}

function parseNumstatHeader(
  record: string,
): { rawAdditions: string; rawDeletions: string; path: string } | undefined {
  const firstTab = record.indexOf("\t");
  const secondTab = record.indexOf("\t", firstTab + 1);
  if (firstTab < 0 || secondTab < 0) {
    return undefined;
  }
  return {
    rawAdditions: record.slice(0, firstTab),
    rawDeletions: record.slice(firstTab + 1, secondTab),
    path: record.slice(secondTab + 1),
  };
}

function parseRawPatch(output: string): { filePaths: string[]; patch: string } {
  const rawPatchSeparator = "\0\0";
  const separatorIndex = output.indexOf(rawPatchSeparator);
  if (separatorIndex < 0) {
    return { filePaths: parseRawPatchPaths(output), patch: "" };
  }
  return {
    filePaths: parseRawPatchPaths(output.slice(0, separatorIndex)),
    patch: output.slice(separatorIndex + rawPatchSeparator.length),
  };
}

/** The file path of each patch section, in the order Git writes them. */
function parseRawPatchPaths(raw: string): string[] {
  const fields = raw.split("\0");
  const filePaths: string[] = [];
  let index = 0;
  while (index < fields.length) {
    const metadata = fields[index++];
    if (!metadata) {
      continue;
    }
    const rawStatus = metadata.slice(metadata.lastIndexOf(" ") + 1);
    const firstPath = fields[index++] ?? "";
    const hasSecondPath = rawStatus.startsWith("R") || rawStatus.startsWith("C");
    const filePath = hasSecondPath ? fields[index++] || firstPath : firstPath;
    // Git splits a type change into a deletion patch and a creation patch for the same path.
    filePaths.push(...(rawStatus === "T" ? [filePath, filePath] : [filePath]));
  }
  return filePaths;
}

function baseFile(filePath: string, status: FileStatus, previousPath?: string): DiffFile {
  const file: DiffFile = {
    path: filePath,
    status,
    language: languageForPath(filePath),
    additions: 0,
    deletions: 0,
    hunks: [],
    commentableRanges: [],
  };
  if (previousPath) {
    file.previousPath = previousPath;
  }
  return file;
}

function parseFileStatus(rawStatus: string): FileStatus {
  if (rawStatus.startsWith("R")) {
    return "renamed";
  }
  if (rawStatus === "A") {
    return "added";
  }
  if (rawStatus === "D") {
    return "removed";
  }
  return "modified";
}

function getExcludedReason(file: DiffFile): string | undefined {
  const pathExcludedReason = getPathExcludedReason(file);
  if (pathExcludedReason) {
    return pathExcludedReason;
  }
  if (file.additions + file.deletions > maxInlineChangedLines) {
    return "oversized diff";
  }
  if (commentableRangeLineCount(file.commentableRanges) > maxCommentableRangeLines) {
    return "oversized diff";
  }
  return undefined;
}

function getPathExcludedReason(file: Pick<DiffFile, "path" | "status">): string | undefined {
  if (file.status === "removed") {
    return "removed file";
  }
  if (lockFilePattern.test(file.path)) {
    return "lock file";
  }
  if (generatedPattern.test(file.path)) {
    return "generated or build output";
  }
  return undefined;
}

function commentableRangeLineCount(ranges: readonly CommentableRange[]): number {
  return ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
}

function languageForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).slice(1);
  return extension || undefined;
}
