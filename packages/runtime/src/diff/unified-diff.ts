import type { CommentableRange, DiffHunk, RangeKind, ReviewSide } from "../types.js";

/** Hunks and commentable ranges parsed from one file's section of a unified diff. */
type ParsedUnifiedDiffFile = {
  hunks: DiffHunk[];
  commentableRanges: CommentableRange[];
};

/**
 * Parses unified patch text into per-file hunks and commentable ranges. `filePaths` names the files in patch
 * order; each file header advances to the next one.
 */
export function parseUnifiedDiff(
  diff: string,
  filePaths: readonly string[],
): Map<string, ParsedUnifiedDiffFile> {
  const state = createDiffParserState(filePaths);

  for (const line of diff.split("\n")) {
    parseUnifiedDiffLine(state, line);
  }

  finishActiveHunk(state);
  return state.filesByPath;
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
  filePaths: readonly string[];
  nextFileIndex: number;
  currentPath?: string;
  activeHunk?: ActiveHunk;
};

function createDiffParserState(filePaths: readonly string[]): DiffParserState {
  return {
    filesByPath: new Map(),
    filePaths,
    nextFileIndex: 0,
  };
}

function parseUnifiedDiffLine(state: DiffParserState, line: string): void {
  if (line.startsWith("diff --git ")) {
    resetFileState(state);
    return;
  }

  if (line.startsWith("@@")) {
    startHunk(state, line);
    return;
  }

  if (!state.activeHunk) {
    return;
  }

  applyHunkLine(state, line);
}

function resetFileState(state: DiffParserState): void {
  finishActiveHunk(state);
  state.currentPath = state.filePaths[state.nextFileIndex];
  state.nextFileIndex += 1;
  if (state.currentPath) {
    ensureParsedFile(state, state.currentPath);
  }
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

  if (line.startsWith("\\")) {
    hunk.bodyLines.push(line);
    flushPendingRange(state);
    return;
  }
  // Once the @@ header line counts are consumed, nothing else belongs to the
  // hunk; inside it, `---`/`+++` prefixes are removed/added content.
  if (isHunkExhausted(hunk)) {
    flushPendingRange(state);
    return;
  }
  if (line.startsWith(" ")) {
    hunk.bodyLines.push(line);
    flushPendingRange(state);
    hunk.oldLine += 1;
    hunk.newLine += 1;
    return;
  }
  if (line.startsWith("+")) {
    hunk.bodyLines.push(line);
    applyCommentableLine(state, "RIGHT", hunk.newLine, line.slice(1), "added");
    hunk.newLine += 1;
    return;
  }
  if (line.startsWith("-")) {
    hunk.bodyLines.push(line);
    applyCommentableLine(state, "LEFT", hunk.oldLine, line.slice(1), "deleted");
    hunk.oldLine += 1;
    return;
  }
  flushPendingRange(state);
}

function isHunkExhausted(hunk: ActiveHunk): boolean {
  return (
    hunk.oldLine >= hunk.oldStart + hunk.oldLines && hunk.newLine >= hunk.newStart + hunk.newLines
  );
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
