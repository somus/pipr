import path from "node:path";
import {
  FileSystemRunArchiveSource,
  GitHubRunArchiveSource,
  type RunArchiveSource,
  type RunQuery,
  type RunRecord,
} from "@usepipr/runtime";
import { defaultLocalTraceStore } from "./runs-paths.js";
import type { RunSelector } from "./runs-types.js";

function localSource(
  store: string,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): FileSystemRunArchiveSource {
  return new FileSystemRunArchiveSource(path.resolve(context.cwd, store));
}

export type SourceEntry = {
  name: RunRecord["source"];
  archiveSource: RunArchiveSource;
};

export type CollectedRecord = RunRecord & { archiveSource: RunArchiveSource };

export function publicRunRecord(record: CollectedRecord): RunRecord {
  const { archiveSource: _, ...publicRecord } = record;
  return publicRecord;
}

export async function runSources(
  store: string | undefined,
  context: { env: NodeJS.ProcessEnv; cwd: string },
  selector?: Omit<RunSelector, "changeNumber">,
): Promise<SourceEntry[]> {
  const configuredStore = store ?? context.env.PIPR_RUN_STORE_DIR;
  const localStores = configuredStore
    ? [path.resolve(context.cwd, configuredStore)]
    : [
        path.resolve(context.cwd, ".pipr-runs"),
        await defaultLocalTraceStore(context.cwd, context.env),
      ];
  const sources: SourceEntry[] = [...new Set(localStores)].map((localStore) => ({
    name: "filesystem",
    archiveSource: localSource(localStore, context),
  }));
  if (selector?.host === "github") {
    sources.push({ name: "github", archiveSource: githubSource(selector.repository, context.env) });
  }
  return sources;
}

function githubSource(repository: string, env: NodeJS.ProcessEnv): RunArchiveSource {
  const token = env.PIPR_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  return new GitHubRunArchiveSource({
    repository,
    ...(token ? { token } : {}),
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });
}

export async function collectRecords(
  sources: SourceEntry[],
  query: RunQuery,
): Promise<{
  records: CollectedRecord[];
  errors: Array<{ source: RunRecord["source"]; message: string }>;
}> {
  const settled = await Promise.allSettled(
    sources.map(async (source) => ({ source, records: await source.archiveSource.list(query) })),
  );
  const errors: Array<{ source: RunRecord["source"]; message: string }> = [];
  const byExecutionId = new Map<string, CollectedRecord>();
  const collectSourceRecords = (source: SourceEntry, records: RunRecord[]) => {
    for (const record of records) {
      const collected = { ...record, archiveSource: source.archiveSource };
      const existing = byExecutionId.get(record.executionId);
      if (!existing || recordPreference(collected) > recordPreference(existing)) {
        byExecutionId.set(record.executionId, collected);
      }
    }
  };
  for (const [index, result] of settled.entries()) {
    const source = sources[index];
    if (!source) continue;
    if (result.status === "rejected") {
      errors.push({
        source: source.name,
        message:
          result.reason instanceof Error ? result.reason.message : "run source lookup failed",
      });
    }
    const records = result.status === "fulfilled" ? result.value.records : [];
    collectSourceRecords(source, records);
  }
  return {
    records: [...byExecutionId.values()]
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
      .slice(0, query.limit ?? 20),
    errors,
  };
}

export async function collectExactRecord(
  sources: SourceEntry[],
  query: RunQuery & { executionId: string },
): ReturnType<typeof collectRecords> {
  const localSources = sources.filter((source) => source.name === "filesystem");
  const local = await collectRecords(localSources, query);
  if (local.records.some((record) => isCompletedAvailableRun(record))) return local;
  return await collectRecords(sources, query);
}

function recordPreference(record: CollectedRecord): number {
  const availability = record.state === "available" ? 10 : record.state === "in-progress" ? 5 : 0;
  return availability + (record.source === "filesystem" ? 1 : 0);
}

export function withLookupErrors(
  message: string,
  errors: Array<{ source: RunRecord["source"]; message: string }>,
): string {
  return errors.length === 0
    ? message
    : `${message}; ${errors.map((error) => `${error.source}: ${error.message}`).join("; ")}`;
}

export function isCompletedAvailableRun(record: CollectedRecord): boolean {
  return record.state === "available" && record.outcome !== "in-progress";
}

export function validExecutionId(executionId: string): string {
  if (!/^[a-f0-9]{32}$/.test(executionId)) {
    throw new Error("Execution ID must be a 32-character lowercase hexadecimal trace ID");
  }
  return executionId;
}

export function requireAvailableRun(selected: CollectedRecord, executionId: string): void {
  if (selected.state !== "available") {
    throw new Error(unavailableRunMessage(selected, executionId));
  }
}

export function unavailableRunMessage(selected: RunRecord, executionId: string): string {
  return `Pipr run ${executionId} is ${selected.state} and cannot be downloaded`;
}
