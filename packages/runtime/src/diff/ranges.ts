import type { CommentableRange, DiffHunk, DiffManifest, DiffManifestFile } from "../types.js";

export type DiffRangeMatch = {
  file: DiffManifestFile;
  range: CommentableRange;
};

export type DiffRangeIndex = {
  fileByPath(filePath: string): DiffManifestFile | undefined;
  excludedReason(filePath: string): string | undefined;
  findRange(rangeId: string): DiffRangeMatch | undefined;
  rangeById(rangeId: string): CommentableRange | undefined;
  requireFile(filePath: string): DiffManifestFile;
  requireRangeInFile(file: DiffManifestFile, rangeId: string): CommentableRange;
  requireHunk(file: DiffManifestFile, range: CommentableRange): DiffHunk;
};

export function createDiffRangeIndex(manifest: DiffManifest): DiffRangeIndex {
  const filesByPath = new Map(manifest.files.map((file) => [file.path, file]));
  const rangesById = new Map<string, DiffRangeMatch>();
  for (const file of manifest.files) {
    for (const range of file.commentableRanges) {
      rangesById.set(range.id, { file, range });
    }
  }

  return {
    fileByPath(filePath) {
      return filesByPath.get(filePath);
    },
    excludedReason(filePath) {
      return filesByPath.get(filePath)?.excludedReason;
    },
    findRange(rangeId) {
      return rangesById.get(rangeId);
    },
    rangeById(rangeId) {
      return rangesById.get(rangeId)?.range;
    },
    requireFile(filePath) {
      const file = filesByPath.get(filePath);
      if (!file) {
        throw new Error(`Path '${filePath}' is not in the Diff Manifest`);
      }
      return file;
    },
    requireRangeInFile(file, rangeId) {
      const range = file.commentableRanges.find((item) => item.id === rangeId);
      if (range) {
        return range;
      }
      if (rangesById.has(rangeId)) {
        throw new Error(`Diff Manifest range '${rangeId}' is not in path '${file.path}'`);
      }
      throw new Error(`Unknown Diff Manifest range '${rangeId}'`);
    },
    requireHunk(file, range) {
      const hunk = file.hunks.find(
        (item) => item.hunkIndex === range.hunkIndex && item.contentHash === range.hunkContentHash,
      );
      if (!hunk) {
        throw new Error(`Diff Manifest range '${range.id}' has no matching hunk`);
      }
      return hunk;
    },
  };
}
