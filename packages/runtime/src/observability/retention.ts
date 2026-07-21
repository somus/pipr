import { rm } from "node:fs/promises";
import path from "node:path";
import { readStoredRuns } from "./retention-store.js";

const dayMilliseconds = 24 * 60 * 60 * 1000;

export async function enforceRunStoreRetention(options: {
  rootDirectory: string;
  retentionDays?: number;
  maxBytes?: number;
  now?: Date;
}): Promise<{ expired: string[]; quota: string[]; retainedBytes: number }> {
  const retentionDays = options.retentionDays ?? 14;
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024 * 1024;
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new Error("Run retention days must be a positive integer");
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Run store max bytes must be a positive integer");
  }
  const rootDirectory = path.resolve(options.rootDirectory);
  const cutoff = (options.now ?? new Date()).getTime() - retentionDays * dayMilliseconds;
  const runs = await readStoredRuns(rootDirectory);
  const expired: string[] = [];
  for (const run of runs) {
    if (run.active || run.completedAt >= cutoff) continue;
    await rm(run.directory, { recursive: true, force: true });
    run.removed = true;
    expired.push(run.executionId);
  }

  let retainedBytes = runs.filter((run) => !run.removed).reduce((sum, run) => sum + run.bytes, 0);
  const quota: string[] = [];
  const completed = runs
    .filter((run) => !run.removed && !run.active)
    .sort(
      (left, right) =>
        left.completedAt - right.completedAt || left.executionId.localeCompare(right.executionId),
    );
  for (const run of completed) {
    if (retainedBytes <= maxBytes) break;
    await rm(run.directory, { recursive: true, force: true });
    run.removed = true;
    retainedBytes -= run.bytes;
    quota.push(run.executionId);
  }
  return { expired, quota, retainedBytes };
}
