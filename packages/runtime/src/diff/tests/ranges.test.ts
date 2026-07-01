import { describe, expect, it } from "bun:test";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import { createDiffRangeIndex } from "../ranges.js";

const manifest = reviewTestManifest({ includeExcludedLock: true });

describe("Diff Ranges", () => {
  it("indexes files, ranges, excluded reasons, and hunks", () => {
    const index = createDiffRangeIndex(manifest);
    const file = index.requireFile("src/a.ts");
    const range = index.requireRangeInFile(file, "range-1");

    expect(file.path).toBe("src/a.ts");
    expect(range.id).toBe("range-1");
    expect(index.rangeById("range-1")).toEqual(range);
    expect(index.excludedReason("bun.lock")).toBe("lock file");
    expect(index.requireHunk(file, range).contentHash).toBe(range.hunkContentHash);
  });

  it("reports lookup failures with stable messages", () => {
    const sourceFile = manifest.files[0];
    if (!sourceFile) {
      throw new Error("test fixture missing file");
    }
    const sourceRange = sourceFile.commentableRanges[0];
    if (!sourceRange) {
      throw new Error("test fixture missing range");
    }
    const index = createDiffRangeIndex({
      ...manifest,
      files: [
        ...manifest.files,
        {
          ...sourceFile,
          path: "src/b.ts",
          commentableRanges: [{ ...sourceRange, id: "range-b", path: "src/b.ts" }],
        },
      ],
    });
    const file = index.requireFile("src/a.ts");

    expect(() => index.requireFile("missing.ts")).toThrow("is not in the Diff Manifest");
    expect(() => index.requireRangeInFile(file, "missing")).toThrow("Unknown Diff Manifest range");
    expect(() => index.requireRangeInFile(file, "range-b")).toThrow("is not in path 'src/a.ts'");
  });
});
