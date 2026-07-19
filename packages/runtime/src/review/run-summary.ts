import type { PiprRunSummary } from "@usepipr/sdk";
import { piprResultLimits } from "@usepipr/sdk/internal";
import type { ChangeRequestEventContext } from "../types.js";
import type { PiRunStats } from "./agent/review-run.js";
import { reviewStatsForRuns } from "./task/task-output.js";

export function createPiprRunSummary(options: {
  runId: string;
  trigger: PiprRunSummary["trigger"];
  event: ChangeRequestEventContext;
  selectedTasks: readonly string[];
  piRuns: PiRunStats[];
  durationMs: number;
}): PiprRunSummary {
  const stats = reviewStatsForRuns(options.piRuns, options.durationMs);
  return {
    id: options.runId,
    trigger: options.trigger,
    baseSha: options.event.change.base.sha,
    headSha: options.event.change.head.sha,
    tasks: options.selectedTasks
      .slice(0, piprResultLimits.runTasks)
      .map((task) => task.slice(0, piprResultLimits.runTextLength)),
    durationMs: options.durationMs,
    models: stats?.models ?? [],
    agentRuns: stats?.agentRuns ?? 0,
    inputTokens: stats?.inputTokens ?? 0,
    outputTokens: stats?.outputTokens ?? 0,
    costUsd: stats?.costUsd ?? 0,
    usageStatus: stats?.usageStatus ?? "unavailable",
  };
}
