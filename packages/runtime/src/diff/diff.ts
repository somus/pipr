import path from "node:path";
import type {
  CommentableRange,
  DiffHunk,
  DiffManifest,
  DiffManifestFile,
  FileStatus,
  RangeKind,
  ReviewSide,
} from "../types.js";
import { parseDiffManifest } from "../types.js";
import { runGit } from "./git.js";

type DiffFile = DiffManifestFile;
type ParsedUnifiedDiffFile = Pick<DiffManifestFile, "hunks" | "commentableRanges">;
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

export type BuildDiffManifestOptions = {
  cwd: string;
  baseSha: string;
  headSha: string;
  includeWorkingTree?: boolean;
};

export function buildDiffManifest(options: BuildDiffManifestOptions): DiffManifest {
  const mergeBaseSha = runGit(["merge-base", options.baseSha, options.headSha], options.cwd).trim();
  const diffHead = options.includeWorkingTree ? undefined : options.headSha;
  const nameStatus = runGit(
    buildDiffArgs(["--name-status", "--find-renames"], mergeBaseSha, diffHead),
    options.cwd,
  );
  const diffStats = getDiffStats(options.cwd, mergeBaseSha, diffHead);
  const preExcludedFiles = getPreExcludedFiles(diffStats);
  const diff = runGit(buildUnifiedDiffArgs(mergeBaseSha, diffHead, preExcludedFiles), options.cwd);

  const files = parseNameStatus(nameStatus);
  const parsedDiff = parseUnifiedDiff(diff);
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

export function parseNameStatus(output: string): DiffFile[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map(parseNameStatusLine);
}

export function parseUnifiedDiff(diff: string): Map<string, ParsedUnifiedDiffFile> {
  const state = createDiffParserState();

  for (const line of diff.split("\n")) {
    parseUnifiedDiffLine(state, line);
  }

  finishActiveHunk(state);
  return state.filesByPath;
}

function getDiffStats(
  cwd: string,
  baseSha: string,
  headSha: string | undefined,
): Map<string, DiffStat> {
  const output = runGit(buildDiffArgs(["--numstat", "--find-renames"], baseSha, headSha), cwd);
  const stats = new Map<string, DiffStat>();
  for (const line of output.split("\n").filter(Boolean)) {
    const stat = parseNumstatLine(line);
    if (!stat) {
      continue;
    }
    if (stat.kind === "binary") {
      stats.set(stat.path, { additions: 0, deletions: 0, excludedReason: "binary diff" });
      continue;
    }
    stats.set(stat.path, {
      additions: stat.additions,
      deletions: stat.deletions,
      excludedReason: stat.changedLines > maxInlineChangedLines ? "oversized diff" : undefined,
    });
  }
  return stats;
}

function getPreExcludedFiles(stats: Map<string, DiffStat>): Map<string, string> {
  const excluded = new Map<string, string>();
  for (const [filePath, stat] of stats) {
    if (stat.excludedReason) {
      excluded.set(filePath, stat.excludedReason);
    }
  }
  return excluded;
}

function buildUnifiedDiffArgs(
  baseSha: string,
  headSha: string | undefined,
  excludedFiles: Map<string, string>,
): string[] {
  const args = buildDiffArgs(["--unified=80", "--find-renames"], baseSha, headSha);
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

function parseNumstatLine(
  line: string,
):
  | { kind: "text"; path: string; additions: number; deletions: number; changedLines: number }
  | { kind: "binary"; path: string }
  | undefined {
  const [rawAdditions, rawDeletions, ...pathParts] = line.split("\t");
  const filePath = pathParts.join("\t");
  if (!rawAdditions || !rawDeletions || !filePath) {
    return undefined;
  }
  if (rawAdditions === "-" || rawDeletions === "-") {
    return { kind: "binary", path: normalizeNumstatPath(filePath) };
  }
  const additions = Number(rawAdditions);
  const deletions = Number(rawDeletions);
  return {
    kind: "text",
    path: normalizeNumstatPath(filePath),
    additions,
    deletions,
    changedLines: additions + deletions,
  };
}

function normalizeNumstatPath(filePath: string): string {
  if (filePath.includes("{") && filePath.includes(" => ") && filePath.includes("}")) {
    return filePath.replace(/\{(?<before>.*) => (?<after>.*)\}/, "$<after>");
  }
  const renameTarget = / => (?<target>.*)$/.exec(filePath)?.groups?.target;
  return renameTarget ?? filePath;
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

function parseNameStatusLine(line: string): DiffFile {
  const [rawStatus = "M", firstPath = "", secondPath = ""] = line.split("\t");
  const status = parseFileStatus(rawStatus);
  if (status === "renamed") {
    return baseFile(secondPath || firstPath, "renamed", firstPath);
  }
  return baseFile(firstPath, status);
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
  if (file.status === "removed") {
    return "removed file";
  }
  if (lockFilePattern.test(file.path)) {
    return "lock file";
  }
  if (generatedPattern.test(file.path)) {
    return "generated or build output";
  }
  if (file.additions + file.deletions > maxInlineChangedLines) {
    return "oversized diff";
  }
  if (commentableRangeLineCount(file.commentableRanges) > maxCommentableRangeLines) {
    return "oversized diff";
  }
  return undefined;
}

function commentableRangeLineCount(ranges: CommentableRange[]): number {
  return ranges.reduce((total, range) => total + range.endLine - range.startLine + 1, 0);
}

function languageForPath(filePath: string): string | undefined {
  const extension = path.extname(filePath).slice(1);
  return extension || undefined;
}

function makeRangeId(
  filePath: string,
  hunkIndex: number,
  side: ReviewSide,
  startLine: number,
  endLine: number,
  hunkContentHash: string,
): string {
  return [
    "rng",
    hashPart(filePath, 8),
    `h${hunkIndex}`,
    side,
    String(startLine),
    String(endLine),
    hunkContentHash,
  ].join("_");
}

function hashPart(value: string, length: number): string {
  return new Bun.CryptoHasher("sha1").update(value).digest("hex").slice(0, length);
}

type PendingRange = {
  side: ReviewSide;
  startLine: number;
  endLine: number;
  kind: RangeKind;
  preview: string[];
};

type HunkRangeDraft = Omit<CommentableRange, "id" | "hunkContentHash">;

type ActiveHunk = {
  path: string;
  hunkIndex: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  oldLine: number;
  newLine: number;
  bodyLines: string[];
  ranges: HunkRangeDraft[];
  pending?: PendingRange;
};

type DiffParserState = {
  filesByPath: Map<string, ParsedUnifiedDiffFile>;
  currentPath?: string;
  activeHunk?: ActiveHunk;
};

function createDiffParserState(): DiffParserState {
  return {
    filesByPath: new Map(),
  };
}

function parseUnifiedDiffLine(state: DiffParserState, line: string): void {
  if (line.startsWith("diff --git ")) {
    resetFileState(state);
    return;
  }

  if (line.startsWith("+++ b/")) {
    state.currentPath = line.slice("+++ b/".length);
    ensureParsedFile(state, state.currentPath);
    return;
  }

  if (line.startsWith("@@")) {
    startHunk(state, line);
    return;
  }

  if (!state.activeHunk || line.startsWith("+++ /dev/null")) {
    return;
  }

  applyHunkLine(state, line);
}

function resetFileState(state: DiffParserState): void {
  finishActiveHunk(state);
  state.currentPath = undefined;
}

function startHunk(state: DiffParserState, line: string): void {
  finishActiveHunk(state);
  if (!state.currentPath) {
    return;
  }
  const location = parseHunkLocation(line);
  if (location) {
    const file = ensureParsedFile(state, state.currentPath);
    state.activeHunk = {
      path: state.currentPath,
      hunkIndex: file.hunks.length + 1,
      header: line.trim(),
      oldStart: location.oldStart,
      oldLines: location.oldLines,
      newStart: location.newStart,
      newLines: location.newLines,
      oldLine: location.oldStart,
      newLine: location.newStart,
      bodyLines: [],
      ranges: [],
    };
  }
}

function parseHunkLocation(line: string):
  | {
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
    }
  | undefined {
  const match =
    /@@ -(?<oldStart>\d+)(?:,(?<oldLines>\d+))? \+(?<newStart>\d+)(?:,(?<newLines>\d+))? @@/.exec(
      line,
    );
  if (!match) {
    return undefined;
  }
  const groups = match.groups;
  if (!groups) {
    return undefined;
  }
  return {
    oldStart: Number(groups.oldStart),
    oldLines: groups.oldLines === undefined ? 1 : Number(groups.oldLines),
    newStart: Number(groups.newStart),
    newLines: groups.newLines === undefined ? 1 : Number(groups.newLines),
  };
}

function applyHunkLine(state: DiffParserState, line: string): void {
  const hunk = state.activeHunk;
  if (!hunk) {
    return;
  }

  if (line.startsWith(" ")) {
    hunk.bodyLines.push(line);
    flushPendingRange(state);
    hunk.oldLine += 1;
    hunk.newLine += 1;
    return;
  }
  if (line.startsWith("+") && !line.startsWith("+++")) {
    hunk.bodyLines.push(line);
    applyCommentableLine(state, "RIGHT", hunk.newLine, line.slice(1), "added");
    hunk.newLine += 1;
    return;
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    hunk.bodyLines.push(line);
    applyCommentableLine(state, "LEFT", hunk.oldLine, line.slice(1), "deleted");
    hunk.oldLine += 1;
    return;
  }
  if (line.startsWith("\\")) {
    hunk.bodyLines.push(line);
  }
  flushPendingRange(state);
}

function applyCommentableLine(
  state: DiffParserState,
  side: ReviewSide,
  lineNumber: number,
  preview: string,
  kind: RangeKind,
): void {
  const hunk = state.activeHunk;
  if (!hunk) {
    return;
  }
  hunk.pending = extendOrStartRange(hunk.pending, side, lineNumber, preview, kind, () =>
    flushPendingRange(state),
  );
}

function flushPendingRange(state: DiffParserState): void {
  const hunk = state.activeHunk;
  if (!hunk?.pending) {
    return;
  }

  const pending = hunk.pending;
  hunk.ranges.push({
    path: hunk.path,
    side: pending.side,
    startLine: pending.startLine,
    endLine: pending.endLine,
    kind: pending.kind,
    hunkIndex: hunk.hunkIndex,
    hunkHeader: hunk.header,
    preview: pending.preview.join("\n"),
  });
  hunk.pending = undefined;
}

function finishActiveHunk(state: DiffParserState): void {
  const hunk = state.activeHunk;
  if (!hunk) {
    return;
  }
  flushPendingRange(state);
  const file = ensureParsedFile(state, hunk.path);
  const contentHash = hashPart(`${hunk.header}\n${hunk.bodyLines.join("\n")}`, 12);
  const diffHunk: DiffHunk = {
    hunkIndex: hunk.hunkIndex,
    header: hunk.header,
    oldStart: hunk.oldStart,
    oldLines: hunk.oldLines,
    newStart: hunk.newStart,
    newLines: hunk.newLines,
    contentHash,
  };
  file.hunks.push(diffHunk);
  for (const range of hunk.ranges) {
    file.commentableRanges.push({
      ...range,
      id: makeRangeId(
        range.path,
        range.hunkIndex,
        range.side,
        range.startLine,
        range.endLine,
        contentHash,
      ),
      hunkContentHash: contentHash,
    });
  }
  state.activeHunk = undefined;
}

function ensureParsedFile(state: DiffParserState, filePath: string): ParsedUnifiedDiffFile {
  const existing = state.filesByPath.get(filePath);
  if (existing) {
    return existing;
  }
  const file: ParsedUnifiedDiffFile = { hunks: [], commentableRanges: [] };
  state.filesByPath.set(filePath, file);
  return file;
}

function extendOrStartRange(
  pending: PendingRange | undefined,
  side: ReviewSide,
  line: number,
  preview: string,
  kind: RangeKind,
  flush: () => void,
): PendingRange {
  if (pending && pending.side === side && pending.endLine + 1 === line) {
    pending.endLine = line;
    pending.kind = mergeRangeKind(pending.kind, kind);
    pending.preview.push(preview);
    return pending;
  }

  flush();
  return {
    side,
    startLine: line,
    endLine: line,
    kind,
    preview: [preview],
  };
}

function mergeRangeKind(left: RangeKind, right: RangeKind): RangeKind {
  return left === right ? left : "mixed";
}
