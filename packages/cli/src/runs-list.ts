import { printRunList } from "./runs-print.js";
import { parseKind, parseLimit, parseStatus, resolveRunSelector } from "./runs-selector.js";
import { collectRecords, publicRunRecord, runSources } from "./runs-sources.js";
import type { RunsListOptions } from "./runs-types.js";

export async function runRunsList(
  options: RunsListOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const selector = await resolveRunSelector({ ...options, cwd: context.cwd });
  const collected = await collectRecords(await runSources(options.store, context, selector), {
    ...selector,
    kind: parseKind(options.kind, "all"),
    ...(options.status ? { status: parseStatus(options.status) } : {}),
    limit: parseLimit(options.limit),
  });
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          formatVersion: 1,
          runs: collected.records.map(publicRunRecord),
          errors: collected.errors,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const error of collected.errors)
    console.error(`pipr warning ${error.source}: ${error.message}`);
  printRunList(collected.records);
}
