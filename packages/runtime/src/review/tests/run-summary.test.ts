import { describe, expect, it } from "bun:test";
import { piprResultLimits } from "@usepipr/sdk/internal";
import { createPiprRunSummary } from "../run-summary.js";
import { eventContext } from "./task-runtime-fixtures.js";

describe("createPiprRunSummary", () => {
  it("projects task metadata within the public result bounds", () => {
    const summary = createPiprRunSummary({
      runId: "run-1",
      trigger: "local",
      event: eventContext(),
      selectedTasks: [
        "x".repeat(piprResultLimits.runTextLength + 1),
        ...Array.from({ length: piprResultLimits.runTasks }, (_, index) => `task-${index}`),
      ],
      piRuns: [],
      durationMs: 10,
    });

    expect(summary.tasks).toHaveLength(piprResultLimits.runTasks);
    expect(summary.tasks[0]).toHaveLength(piprResultLimits.runTextLength);
  });

  it("collects nonzero partial usage from Pi runs", () => {
    const summary = createPiprRunSummary({
      runId: "run-1",
      trigger: "command",
      event: eventContext(),
      selectedTasks: ["ask"],
      piRuns: [
        {
          models: ["reported-model"],
          usage: {
            status: "complete",
            inputTokens: 120,
            outputTokens: 12,
            costUsd: 0.0012,
          },
        },
        { models: ["unreported-model"] },
      ],
      durationMs: 20,
    });

    expect(summary).toMatchObject({
      models: ["reported-model", "unreported-model"],
      agentRuns: 2,
      inputTokens: 120,
      outputTokens: 12,
      costUsd: 0.0012,
      usageStatus: "partial",
    });
  });
});
