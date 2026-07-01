import { describe, expect, it } from "bun:test";
import type { DiffManifest } from "../../types.js";
import {
  diffManifestHasPathMatch,
  filterDiffManifestByPaths,
  pathMatchesFilter,
} from "../path-filter.js";

describe("path filters", () => {
  it("matches glob patterns with include default and exclude precedence", () => {
    expect(pathMatchesFilter("src/a.ts", undefined)).toBe(true);
    expect(pathMatchesFilter("src/a.ts", { include: ["*.ts"] })).toBe(true);
    expect(pathMatchesFilter("src/a.ts", { include: ["src/**"] })).toBe(true);
    expect(pathMatchesFilter(".github/workflows/pipr.yml", { include: [".github/**"] })).toBe(true);
    expect(
      pathMatchesFilter("src/a.test.ts", {
        include: ["src/**"],
        exclude: ["**/*.test.ts"],
      }),
    ).toBe(false);
  });

  it("filters Diff Manifest files by current path, previous path, and excluded files", () => {
    const filtered = filterDiffManifestByPaths(manifest(), {
      include: ["packages/old.ts", "bun.lock"],
    });

    expect(filtered.files.map((file) => file.path)).toEqual(["packages/new.ts", "bun.lock"]);
    expect(filtered.files.find((file) => file.path === "bun.lock")?.excludedReason).toBe(
      "lock file",
    );
  });

  it("lets exclude win across renamed current and previous paths", () => {
    expect(
      filterDiffManifestByPaths(manifest(), {
        include: ["packages/old.ts"],
        exclude: ["packages/new.ts"],
      }).files.map((file) => file.path),
    ).toEqual([]);
    expect(
      diffManifestHasPathMatch(manifest(), {
        include: ["packages/new.ts"],
        exclude: ["packages/old.ts"],
      }),
    ).toBe(false);
  });

  it("reports whether any Diff Manifest file matches", () => {
    expect(diffManifestHasPathMatch(manifest(), { include: ["docs/**"] })).toBe(true);
    expect(diffManifestHasPathMatch(manifest(), { include: ["apps/web/**"] })).toBe(false);
  });
});

function manifest(): DiffManifest {
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [
      file("src/a.ts"),
      file("docs/readme.md"),
      {
        ...file("packages/new.ts"),
        status: "renamed",
        previousPath: "packages/old.ts",
      },
      {
        ...file("bun.lock"),
        excludedReason: "lock file",
        commentableRanges: [],
      },
    ],
  };
}

function file(path: string): DiffManifest["files"][number] {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    hunks: [],
    commentableRanges: [
      {
        id: `range-${path}`,
        path,
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        kind: "added",
        hunkIndex: 1,
        hunkHeader: "@@ -1 +1 @@",
        hunkContentHash: "deadbeefcafe",
      },
    ],
  };
}
