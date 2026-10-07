import path from "node:path";
import { parseKind, resolveRepositorySelector, resolveRunSelector } from "./runs-selector.js";
import {
  type CollectedRecord,
  collectRecords,
  isCompletedAvailableRun,
  requireAvailableRun,
  runSources,
  type SourceEntry,
  selectRunByExecutionId,
  validExecutionId,
  withLookupErrors,
  withTemporaryRoot,
} from "./runs-sources.js";
import type { RunSelector, RunsShowOptions } from "./runs-types.js";
import { renderDownloadedRun } from "./runs-view.js";

export async function runRunsShow(
  executionId: string | undefined,
  options: RunsShowOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  requireShowSelector(executionId, options.pr);
  const selector = await showRepositorySelector(options, context.cwd);
  const sources = await runSources(options.store, context, selector);
  const selected = await selectRunForShow(executionId, options, selector, sources);
  const resolvedExecutionId = validExecutionId(executionId ?? selected.executionId);
  requireAvailableRun(selected, resolvedExecutionId);
  await renderSelectedRun(selected, resolvedExecutionId, options, context);
}

function requireShowSelector(executionId: string | undefined, pr: string | undefined): void {
  if (!executionId && !pr) throw new Error("Provide an execution ID or --pr <number|URL>");
}

async function showRepositorySelector(
  options: RunsShowOptions,
  cwd: string,
): Promise<Omit<RunSelector, "changeNumber"> | RunSelector | undefined> {
  if (options.pr) return await resolveRunSelector({ ...options, pr: options.pr, cwd });
  return await resolveRepositorySelector({ ...options, cwd }).catch(() => undefined);
}

async function selectRunForShow(
  executionId: string | undefined,
  options: RunsShowOptions,
  selector: Omit<RunSelector, "changeNumber"> | RunSelector | undefined,
  sources: SourceEntry[],
): Promise<CollectedRecord> {
  if (executionId) return await selectRunByExecutionId(executionId, sources);
  if (!options.pr || !selector || !("changeNumber" in selector)) {
    throw new Error("A PR selector is required when no execution ID is provided");
  }
  const collected = await collectRecords(sources, {
    ...selector,
    kind: parseKind(options.kind, "review"),
    limit: 100,
  });
  const selected = collected.records.find(isCompletedAvailableRun);
  if (selected) return selected;
  throw new Error(
    withLookupErrors("No completed Pipr run matched the PR selector", collected.errors),
  );
}

async function renderSelectedRun(
  selected: CollectedRecord,
  executionId: string,
  options: RunsShowOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  await withTemporaryRoot("pipr-runs-show-", async (temporaryRoot) => {
    const downloaded = await selected.archiveSource.download(
      selected.ref,
      path.join(temporaryRoot, executionId),
    );
    await renderDownloadedRun(downloaded, options, context, temporaryRoot);
  });
}
