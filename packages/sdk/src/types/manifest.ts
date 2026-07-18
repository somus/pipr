/** Include/exclude path filter for scoped reviews and Diff Manifest projection. */
export type PathFilter = {
  include?: readonly string[];
  exclude?: readonly string[];
};

/** Side of a change request diff that a commentable range belongs to. */
export type ReviewSide = "RIGHT" | "LEFT";

/** Kind of line span represented by a Diff Manifest commentable range. */
export type RangeKind = "added" | "deleted" | "context" | "mixed";

/** File lifecycle status in a Diff Manifest. */
export type FileStatus = "added" | "modified" | "removed" | "renamed";

/** One changed file returned without its Diff Manifest hunks and ranges. */
export type ChangedFile = {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: FileStatus;
};

/** Commentable line range that can anchor an Inline Review Comment. */
export type CommentableRange = {
  id: string;
  path: string;
  side: ReviewSide;
  startLine: number;
  endLine: number;
  kind: RangeKind;
  hunkIndex: number;
  hunkHeader: string;
  hunkContentHash: string;
  summary?: string;
  preview?: string;
};

/** Diff hunk metadata included in a Diff Manifest file entry. */
export type DiffHunk = {
  hunkIndex: number;
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  contentHash: string;
};

/** One changed file in a Diff Manifest. */
export type DiffManifestFile = {
  path: string;
  previousPath?: string;
  status: FileStatus;
  language?: string;
  additions: number;
  deletions: number;
  hunks: readonly DiffHunk[];
  commentableRanges: readonly CommentableRange[];
  signals?: readonly string[];
  changedSymbols?: readonly string[];
  excludedReason?: string;
};

/** Diff Manifest exposed to reviewers and tasks. */
export type DiffManifest = {
  baseSha: string;
  headSha: string;
  mergeBaseSha: string;
  files: readonly DiffManifestFile[];
};

/** Options for projecting a Diff Manifest for task or prompt use. */
export type DiffManifestOptions = {
  compressed?: boolean;
  includePreviews?: boolean;
  maxPreviewLines?: number;
  paths?: PathFilter;
};

/** Size limits for Diff Manifest prompt and runtime-tool payloads. */
export type DiffManifestLimits = {
  fullMaxBytes?: number;
  fullMaxEstimatedTokens?: number;
  condensedMaxBytes?: number;
  condensedMaxEstimatedTokens?: number;
  toolResponseMaxBytes?: number;
};

/** Runtime limits for a pipr config. */
export type RuntimeLimits = {
  timeoutSeconds?: number;
  diffManifest?: DiffManifestLimits;
};
