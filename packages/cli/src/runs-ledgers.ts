import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type DownloadedBundle,
  type FindingOutcomeSource,
  openRunBundlePackage,
  type RunQuery,
  readFindingEvents,
  webhookFindingOutcomeSources,
} from "@usepipr/runtime";
import {
  type DiagnosticFindingLedger,
  diagnosticFindingLedgerSchema,
  type FindingEvidence,
  type FindingLedger,
  type FindingOutcomeEvent,
  findingLedgerSchema,
  type RunBundleManifest,
} from "@usepipr/sdk";
import { parseLimit, resolveRepositorySelector } from "./runs-selector.js";
import {
  type CollectedRecord,
  collectRecords,
  runSources,
  withTemporaryRoot,
} from "./runs-sources.js";
import type { RunsLedgerOptions } from "./runs-types.js";

/** Finding Outcome events gathered from Run Bundles and the webhook database. */
export type CollectedLedgers = {
  sources: FindingOutcomeSource[];
  /** Diagnostic evidence by finding ID; empty unless bundles were decrypted. */
  evidence: Map<string, FindingEvidence>;
  runs: number;
  webhookEvents: number;
  errors: Array<{ source: string; message: string }>;
};

/**
 * Reads ledgers from local run stores, GitHub Actions archives for a GitHub repository, and the
 * webhook database. Without `identities` only public metadata is read; with them, encrypted
 * diagnostics are opened so the ledger evidence is available.
 */
export async function collectFindingLedgers(
  options: RunsLedgerOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
  identities?: string[],
): Promise<CollectedLedgers> {
  const since = parseSince(options.since);
  const selector = await resolveRepositorySelector({ ...options, cwd: context.cwd }).catch(
    () => undefined,
  );
  const query: RunQuery = {
    kind: "all",
    status: "available",
    limit: parseLimit(options.limit ?? "100"),
    ...(options.host && selector ? { host: selector.host } : {}),
    ...(options.repository ? { repository: options.repository } : {}),
  };
  const collected = await collectRecords(await runSources(options.store, context, selector), query);
  const result: CollectedLedgers = {
    sources: [],
    evidence: new Map(),
    runs: 0,
    webhookEvents: 0,
    errors: [...collected.errors],
  };
  const records = collected.records.filter(
    (record) => !since || !record.startedAt || Date.parse(record.startedAt) >= since.getTime(),
  );
  await withTemporaryRoot("pipr-runs-ledgers-", async (temporaryRoot) => {
    for (const record of records) {
      await readRecordLedger(record, temporaryRoot, identities).then(
        (ledger) => addLedger(result, ledger, since),
        (error: unknown) =>
          result.errors.push({
            source: record.executionId,
            message: error instanceof Error ? error.message : "ledger could not be read",
          }),
      );
    }
  });
  const databasePath = options.webhookDb ?? context.env.PIPR_WEBHOOK_DB;
  if (databasePath) {
    addWebhookEvents(result, path.resolve(context.cwd, databasePath), options.repository, since);
  }
  return result;
}

function addLedger(
  result: CollectedLedgers,
  ledger: DiagnosticFindingLedger | FindingLedger | undefined,
  since: Date | undefined,
): void {
  if (!ledger) return;
  result.runs += 1;
  result.sources.push({
    ...(ledger.threadResolution ? { threadResolution: ledger.threadResolution } : {}),
    events: eventsSince(ledger.events, since),
  });
  const evidence = "evidence" in ledger ? Object.entries(ledger.evidence) : [];
  for (const [findingId, item] of evidence) {
    if (!result.evidence.has(findingId)) result.evidence.set(findingId, item);
  }
}

function addWebhookEvents(
  result: CollectedLedgers,
  databasePath: string,
  repository: string | undefined,
  since: Date | undefined,
): void {
  const rows = readWebhookFindingEvents(databasePath, {
    ...(repository ? { repository } : {}),
    ...(since ? { since } : {}),
  });
  const kept = rows.filter((row) => eventsSince([row.event], since).length > 0);
  result.webhookEvents = kept.length;
  result.sources.push(...webhookFindingOutcomeSources(kept));
}

async function readRecordLedger(
  record: CollectedRecord,
  temporaryRoot: string,
  identities: string[] | undefined,
): Promise<DiagnosticFindingLedger | FindingLedger | undefined> {
  const downloaded = await record.archiveSource.download(
    record.ref,
    path.join(temporaryRoot, record.executionId),
  );
  const bundle = await ledgerBundle(downloaded, temporaryRoot, identities);
  const artifact = bundle.manifest.artifacts.find(
    (candidate) => candidate.kind === "ledger" && !candidate.omitted && !candidate.truncated,
  );
  if (!artifact) return undefined;
  const contents = JSON.parse(await readFile(path.join(bundle.directory, artifact.path), "utf8"));
  const diagnostic = diagnosticFindingLedgerSchema.safeParse(contents);
  return diagnostic.success ? diagnostic.data : findingLedgerSchema.parse(contents);
}

/** Decrypts an age package when identities are given; otherwise the public metadata is used. */
async function ledgerBundle(
  downloaded: DownloadedBundle,
  temporaryRoot: string,
  identities: string[] | undefined,
): Promise<{ directory: string; manifest: RunBundleManifest }> {
  if (
    !identities?.length ||
    downloaded.envelope?.protection !== "age" ||
    !downloaded.packageDirectory
  ) {
    return downloaded;
  }
  const opened = await openRunBundlePackage({
    packageDirectory: downloaded.packageDirectory,
    destination: path.join(temporaryRoot, `${downloaded.manifest.executionId}-diagnostic`),
    identities,
  });
  return opened.bundle;
}

function readWebhookFindingEvents(
  databasePath: string,
  query: Parameters<typeof readFindingEvents>[1],
): ReturnType<typeof readFindingEvents> {
  try {
    return readFindingEvents(databasePath, query);
  } catch (error) {
    if (error instanceof Error && error.message.includes("no such table")) {
      throw new Error(
        `Webhook database ${databasePath} has no finding events yet; run \`pipr webhook serve\` with this database once to initialise them`,
      );
    }
    throw error;
  }
}

function eventsSince(
  events: readonly FindingOutcomeEvent[],
  since: Date | undefined,
): FindingOutcomeEvent[] {
  return since ? events.filter((event) => Date.parse(event.at) >= since.getTime()) : [...events];
}

/** Accepts an ISO 8601 date or timestamp, or a relative age such as `30d`. */
function parseSince(value: string | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const relative = /^(\d+)d$/.exec(value);
  if (relative) return new Date(Date.now() - Number(relative[1]) * 86_400_000);
  const parsed = /^\d{4}-\d{2}-\d{2}/.test(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(parsed)) {
    throw new Error("--since must be an ISO 8601 date or timestamp, or a day count such as 30d");
  }
  return new Date(parsed);
}
