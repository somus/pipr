import {
  type FindingOutcomeStats,
  type FindingStatsGroupBy,
  findingOutcomeStats,
} from "@usepipr/runtime";
import { collectFindingLedgers } from "./runs-ledgers.js";
import type { RunsStatsOptions } from "./runs-types.js";

export async function runRunsStats(
  options: RunsStatsOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const groupBy = parseGroupBy(options.groupBy);
  const collected = await collectFindingLedgers(options, context);
  const stats = findingOutcomeStats(collected.sources, groupBy ? { groupBy } : {});
  const sources = { runs: collected.runs, webhookEvents: collected.webhookEvents };
  if (options.json) {
    console.log(JSON.stringify({ ...stats, sources, errors: collected.errors }, null, 2));
    return;
  }
  for (const error of collected.errors) {
    console.error(`pipr warning ${error.source}: ${error.message}`);
  }
  printStats(stats, sources);
}

function parseGroupBy(value: string | undefined): FindingStatsGroupBy | undefined {
  if (value === undefined) return undefined;
  if (value === "facet" || value === "agent" || value === "model" || value === "config") {
    return value;
  }
  throw new Error("--group-by must be facet, agent, model, or config");
}

function printStats(
  stats: FindingOutcomeStats,
  sources: { runs: number; webhookEvents: number },
): void {
  const { totals } = stats;
  console.log(`Sources: ${sources.runs} runs, ${sources.webhookEvents} webhook events`);
  console.log(
    `Findings: ${totals.findings} (proposed ${totals.proposed}, dropped ${totals.dropped}, published ${totals.published})`,
  );
  console.log(
    `Outcomes: fixed ${totals.fixed}, dismissed ${totals.dismissed}, disputed ${totals.disputed}, open ${totals.open}`,
  );
  console.log(
    `Rates: fix ${percent(totals.rates.fix)}, dismissal ${percent(totals.rates.dismissal)} of ${totals.dismissalEligible}, acceptance ${percent(totals.rates.acceptance)}, drop ${percent(totals.rates.drop)}`,
  );
  console.log(`Drop reasons: ${countList(stats.dropReasons)}`);
  console.log(`Reply permissions: ${countList(stats.replyPermissions)}`);
  if (!stats.groupBy) return;
  const rows = [
    [
      groupHeaders[stats.groupBy],
      "FINDINGS",
      "PUBLISHED",
      "FIXED",
      "DISMISSED",
      "DISPUTED",
      "FIX",
      "DISMISSAL",
      "ACCEPTANCE",
      "DROP",
    ],
    ...stats.groups.map((group) => [
      group.key,
      String(group.findings),
      String(group.published),
      String(group.fixed),
      String(group.dismissed),
      String(group.disputed),
      percent(group.rates.fix),
      percent(group.rates.dismissal),
      percent(group.rates.acceptance),
      percent(group.rates.drop),
    ]),
  ];
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0)),
  );
  console.log("");
  for (const row of rows) {
    console.log(
      row
        .map((cell, column) => cell.padEnd(widths?.[column] ?? 0))
        .join("  ")
        .trimEnd(),
    );
  }
}

const groupHeaders: Record<FindingStatsGroupBy, string> = {
  facet: "FACET",
  agent: "AGENT",
  model: "MODEL",
  config: "CONFIG",
};

function percent(rate: number | null): string {
  return rate === null ? "-" : `${(rate * 100).toFixed(1)}%`;
}

function countList(counts: Partial<Record<string, number>>): string {
  const entries = Object.entries(counts);
  return entries.length === 0
    ? "none"
    : entries.map(([key, count]) => `${key} ${count}`).join(", ");
}
