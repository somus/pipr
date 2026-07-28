import { describe, expect, it } from "bun:test";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import {
  createDiffContextCoverageTracker,
  diffContextCoverageArtifact,
  summarizeDiffContextCoverage,
} from "../diff-context-coverage.js";

describe("Diff Manifest context coverage", () => {
  it("marks every file and range covered when the full manifest is in the prompt", () => {
    const tracker = createDiffContextCoverageTracker({
      manifest: reviewTestManifest({ includeExcludedLock: true }),
      mode: "full",
    });

    expect(summarizeDiffContextCoverage([tracker.result()])).toEqual({
      files: { total: 2, covered: 2 },
      ranges: { total: 2, covered: 2 },
    });
  });

  it("counts only successful non-truncated condensed Diff Manifest reads", () => {
    const tracker = createDiffContextCoverageTracker({
      manifest: reviewTestManifest(),
      mode: "condensed",
    });
    tracker.observe({
      type: "tool_execution_start",
      toolCallId: "read-1",
      toolName: "pipr_read_diff",
      args: { path: "src/a.ts", rangeId: "range-1" },
    });
    tracker.observe({
      type: "tool_execution_end",
      toolCallId: "read-1",
      toolName: "pipr_read_diff",
      result: {
        details: {
          truncated: false,
          value: {
            files: [
              {
                path: "src/a.ts",
                commentableRanges: [{ id: "range-1" }],
              },
            ],
          },
        },
      },
    });
    tracker.observe({
      type: "tool_execution_start",
      toolCallId: "read-2",
      toolName: "pipr_read_at_ref",
      args: { path: "src/a.ts", ref: "head", rangeId: "range-2" },
    });
    tracker.observe({
      type: "tool_execution_end",
      toolCallId: "read-2",
      toolName: "pipr_read_at_ref",
      result: {
        details: {
          path: "src/a.ts",
          rangeId: "range-2",
          available: true,
          truncated: true,
        },
      },
    });

    expect(summarizeDiffContextCoverage([tracker.result()])).toEqual({
      files: { total: 1, covered: 0 },
      ranges: { total: 2, covered: 1 },
    });
  });

  it("requires a successful full-file diff read for zero-range condensed files", () => {
    const tracker = createDiffContextCoverageTracker({
      manifest: reviewTestManifest({ includeExcludedLock: true }),
      mode: "condensed",
    });
    tracker.observe({
      type: "tool_execution_start",
      toolCallId: "read-lock",
      toolName: "pipr_read_diff",
      args: { path: "bun.lock" },
    });
    tracker.observe({
      type: "tool_execution_end",
      toolCallId: "read-lock",
      result: {
        details: {
          truncated: false,
          value: {
            files: [{ path: "bun.lock", commentableRanges: [] }],
          },
        },
      },
    });

    expect(summarizeDiffContextCoverage([tracker.result()])).toEqual({
      files: { total: 2, covered: 1 },
      ranges: { total: 2, covered: 0 },
    });
  });

  it("counts successful declaration reads against their manifest range", () => {
    const tracker = createDiffContextCoverageTracker({
      manifest: reviewTestManifest(),
      mode: "condensed",
    });
    tracker.observe({
      type: "tool_execution_start",
      toolCallId: "declaration-1",
      toolName: "pipr_read_declaration",
      args: { declarationId: "decl-1" },
    });
    tracker.observe({
      type: "tool_execution_end",
      toolCallId: "declaration-1",
      result: {
        details: {
          path: "src/a.ts",
          rangeId: "range-1",
          available: true,
          truncated: false,
        },
      },
    });

    expect(summarizeDiffContextCoverage([tracker.result()])).toEqual({
      files: { total: 1, covered: 0 },
      ranges: { total: 2, covered: 1 },
    });
  });

  it("bounds exact coverage artifacts and reports deterministic omissions", () => {
    const totalFiles = 2_000;
    const artifact = diffContextCoverageArtifact([
      {
        files: Array.from({ length: totalFiles }, (_, index) => ({
          path: `src/${index.toString().padStart(4, "0")}-${"x".repeat(600)}.ts`,
          rangeIds: [`range-${index}`],
          coveredRangeIds: index % 2 === 0 ? [`range-${index}`] : [],
          fullFile: false,
        })),
      },
    ]);
    if (!artifact) throw new Error("expected coverage artifact");

    const parsed = JSON.parse(artifact) as {
      truncated: boolean;
      omittedFiles: number;
      files: Array<{ path: string }>;
    };
    expect(Buffer.byteLength(artifact, "utf8")).toBeLessThanOrEqual(1024 * 1024);
    expect(parsed.truncated).toBe(true);
    expect(parsed.omittedFiles).toBe(totalFiles - parsed.files.length);
    expect(parsed.files[0]?.path).toStartWith("src/0000-");
    expect(parsed.files.at(-1)?.path).toStartWith(
      `src/${(parsed.files.length - 1).toString().padStart(4, "0")}-`,
    );
  });
});
