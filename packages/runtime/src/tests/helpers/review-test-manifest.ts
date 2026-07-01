import type { DiffManifest } from "../../types.js";

export function reviewTestManifest(options: { includeExcludedLock?: boolean } = {}): DiffManifest {
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        hunks: [
          {
            hunkIndex: 1,
            header: "@@ -9,1 +10,3 @@",
            oldStart: 9,
            oldLines: 1,
            newStart: 10,
            newLines: 3,
            contentHash: "deadbeefcafe",
          },
        ],
        commentableRanges: [
          {
            id: "range-1",
            path: "src/a.ts",
            side: "RIGHT",
            startLine: 10,
            endLine: 12,
            kind: "added",
            hunkIndex: 1,
            hunkHeader: "@@ -9,1 +10,3 @@",
            hunkContentHash: "deadbeefcafe",
            preview: "const x = fail();\nreturn x;",
          },
          {
            id: "range-2",
            path: "src/a.ts",
            side: "RIGHT",
            startLine: 20,
            endLine: 22,
            kind: "added",
            hunkIndex: 1,
            hunkHeader: "@@ -9,1 +10,3 @@",
            hunkContentHash: "deadbeefcafe",
            preview: "const x = fail();\nreturn x;",
          },
        ],
      },
      ...excludedLockFile(options.includeExcludedLock ?? false),
    ],
  };
}

function excludedLockFile(include: boolean): DiffManifest["files"] {
  if (!include) {
    return [];
  }
  return [
    {
      path: "bun.lock",
      status: "modified",
      additions: 1,
      deletions: 1,
      excludedReason: "lock file",
      hunks: [],
      commentableRanges: [],
    },
  ];
}
