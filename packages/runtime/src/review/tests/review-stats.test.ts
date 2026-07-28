import { describe, expect, it } from "bun:test";
import type { PiRunStats } from "../agent/review-run.js";
import { accumulateReviewStats, type ReviewStats } from "../review-stats.js";
import { reviewStatsForRuns } from "../task/task-output.js";

describe("review stats", () => {
  it("marks mixed and partial cache reports as partial while retaining safe totals", () => {
    const complete = piRun({
      cacheReadTokens: 20,
      cacheWriteTokens: 2,
      cacheUsageStatus: "complete",
    });
    const unavailable = piRun({});
    const partial = piRun({
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
      cacheUsageStatus: "partial",
    });

    expect(reviewStatsForRuns([complete, unavailable], 10)).toMatchObject({
      cacheReadTokens: 20,
      cacheWriteTokens: 2,
      cacheUsageStatus: "partial",
    });
    expect(reviewStatsForRuns([complete, partial], 10)).toMatchObject({
      cacheReadTokens: 25,
      cacheWriteTokens: 3,
      cacheUsageStatus: "partial",
    });
  });

  it("retains safe cache totals and marks aggregation overflow partial", () => {
    const stats = reviewStatsForRuns(
      [
        piRun({
          cacheReadTokens: Number.MAX_SAFE_INTEGER,
          cacheWriteTokens: 2,
          cacheUsageStatus: "complete",
        }),
        piRun({
          cacheReadTokens: 1,
          cacheWriteTokens: 1,
          cacheUsageStatus: "complete",
        }),
      ],
      10,
    );

    expect(stats).toMatchObject({
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      cacheWriteTokens: 3,
      cacheUsageStatus: "partial",
    });
  });

  it("drops prior diff coverage when the current workflow has no agent runs", () => {
    const prior = reviewStats({
      diffContextCoverage: {
        files: { total: 2, covered: 1 },
        ranges: { total: 3, covered: 2 },
      },
    });

    expect(accumulateReviewStats(prior, undefined)).toEqual(
      expect.not.objectContaining({ diffContextCoverage: expect.anything() }),
    );
    expect(accumulateReviewStats(prior, undefined)).toMatchObject({
      agentRuns: 1,
      inputTokens: 10,
      cacheReadTokens: 4,
    });
  });
});

function piRun(
  cache: Partial<
    Pick<
      NonNullable<PiRunStats["usage"]>,
      "cacheReadTokens" | "cacheWriteTokens" | "cacheUsageStatus"
    >
  >,
): PiRunStats {
  return {
    models: ["test-model"],
    usage: {
      status: "complete",
      inputTokens: 10,
      outputTokens: 2,
      costUsd: 0.01,
      ...cache,
    },
  };
}

function reviewStats(overrides: Partial<ReviewStats> = {}): ReviewStats {
  return {
    models: ["test-model"],
    agentRuns: 1,
    durationMs: 10,
    inputTokens: 10,
    outputTokens: 2,
    costUsd: 0.01,
    usageStatus: "complete",
    cacheReadTokens: 4,
    cacheWriteTokens: 1,
    cacheUsageStatus: "complete",
    ...overrides,
  };
}
