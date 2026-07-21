import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseRunBundleManifest,
  type RunBundleManifest,
  type RunLogRecord,
  type RunMetricsSnapshot,
  type RunSpanRecord,
  runLogRecordSchema,
  runMetricsSnapshotSchema,
  runSpanRecordSchema,
} from "@usepipr/sdk";
import { bundleFilePaths } from "./bundle-files.js";
import { readActiveCaptureMarker } from "./retention-store.js";

export type RunRecordState =
  | "available"
  | "available-in-ci"
  | "in-progress"
  | "expired"
  | "capture-failed"
  | "upload-failed"
  | "not-enabled"
  | "indeterminate-missing";

export type RunQuery = {
  executionId?: string;
  host?: RunBundleManifest["repository"] extends infer _Repository
    ? NonNullable<RunBundleManifest["repository"]>["host"]
    : never;
  repository?: string;
  changeNumber?: number;
  kind?: RunBundleManifest["kind"] | "all";
  status?: RunRecordState | RunBundleManifest["outcome"];
  limit?: number;
};

export type RunRecord = {
  executionId: string;
  workId?: string;
  kind?: RunBundleManifest["kind"];
  outcome?: RunBundleManifest["outcome"];
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  repository?: RunBundleManifest["repository"];
  provider?: RunBundleManifest["provider"];
  state: RunRecordState;
  source: "filesystem" | "github" | "gitlab" | "azure-devops" | "bitbucket";
  nativeUrl?: string;
  ref: RunRef;
};

export type RunRef = {
  executionId: string;
  providerId?: string;
  archiveUrl?: string;
  archiveFormat?: "zip" | "tar.gz";
  preserveArchive?: boolean;
};

export type DownloadedBundle = {
  directory: string;
  manifest: RunBundleManifest;
  archivePath?: string;
};

export interface RunArchiveSource {
  list(query: RunQuery): Promise<RunRecord[]>;
  download(ref: RunRef, destination: string): Promise<DownloadedBundle>;
}

export type ValidatedRunBundle = {
  directory: string;
  manifest: RunBundleManifest;
  spans: RunSpanRecord[];
  logs: RunLogRecord[];
  metrics: RunMetricsSnapshot;
};

export type RunDiagnosis = {
  formatVersion: 1;
  executionId: string;
  criticalPath: Array<{ name: string; durationMs: number; status: RunSpanRecord["status"] }>;
  phaseDurations: Array<{
    name: string;
    durationMs: number;
    status: RunSpanRecord["status"];
  }>;
  agentRetryAttempts: number;
  modelRetryAttempts: number;
  backoffDurationsMs: number[];
  repairAttempts: number;
  timeToFirstTokenMs?: number;
  toolDurations: Array<{
    name: string;
    durationMs: number;
    status: RunSpanRecord["status"];
  }>;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  resources: RunBundleManifest["resources"];
  validationDrops: number;
  publicationFailures: number;
  missingEvidence: string[];
};

export class FileSystemRunArchiveSource implements RunArchiveSource {
  constructor(private readonly rootDirectory: string) {}

  async list(query: RunQuery): Promise<RunRecord[]> {
    const entries = await readStoreEntries(this.rootDirectory);
    const records: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
      const record = await readStoredRecord(this.rootDirectory, entry.name);
      if (matchesQuery(record, query)) records.push(record);
    }
    return records
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
      .slice(0, query.limit ?? 20);
  }

  async download(ref: RunRef, destination: string): Promise<DownloadedBundle> {
    if (!/^[a-f0-9]{32}$/.test(ref.executionId)) throw new Error("Invalid execution ID");
    const source = path.join(this.rootDirectory, ref.executionId);
    return await copyValidatedRunBundle(source, destination);
  }
}

export async function copyValidatedRunBundle(
  source: string,
  destination: string,
): Promise<DownloadedBundle> {
  const bundle = await loadValidatedRunBundle(source);
  await ensureNewDestination(destination);
  for (const relativePath of bundleFilePaths(bundle.manifest)) {
    const target = path.join(destination, relativePath);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path.join(source, relativePath), target);
  }
  const copied = await loadValidatedRunBundle(destination);
  return { directory: destination, manifest: copied.manifest };
}

export async function loadValidatedRunBundle(directory: string): Promise<ValidatedRunBundle> {
  await requireRealDirectory(directory);
  const manifestPath = path.join(directory, "run.json");
  const manifest = parseRunBundleManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const files = await validateBundleFileSet(directory, manifest);
  await validateBundleSize(directory, files, manifest.capture.limitBytes);
  await validateArtifacts(directory, manifest);
  const { spans, logs, metrics } = await loadSignals(directory, manifest);
  validateSignalIdentity(manifest.executionId, spans, logs);
  return { directory, manifest, spans, logs, metrics };
}

export function diagnoseRunBundle(bundle: ValidatedRunBundle): RunDiagnosis {
  const timedSpans = bundle.spans.filter(
    (span): span is RunSpanRecord & { durationMs: number } => span.durationMs !== undefined,
  );
  const phaseDurations = timedSpans
    .filter((span) => span.category === "phase")
    .sort(compareSpans)
    .map(spanSummary);
  const criticalPath = timedSpans
    .filter((span) => span.category !== "run")
    .sort((left, right) => right.durationMs - left.durationMs || compareSpans(left, right))
    .slice(0, 10)
    .map(spanSummary);
  const toolDurations = timedSpans
    .filter((span) => span.category === "tool")
    .sort(compareSpans)
    .map((span) => ({
      name: stringAttribute(span, "gen_ai.tool.name") ?? span.name,
      durationMs: span.durationMs,
      status: span.status,
    }));
  const usage = bundle.spans.reduce(
    (total, span) => ({
      inputTokens: total.inputTokens + numberAttribute(span, "gen_ai.usage.input_tokens"),
      outputTokens: total.outputTokens + numberAttribute(span, "gen_ai.usage.output_tokens"),
      costUsd: total.costUsd + numberAttribute(span, "pipr.usage.cost_usd"),
    }),
    { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  );
  const evidenceKinds = new Set(bundle.manifest.artifacts.map((artifact) => artifact.kind));
  const requiredEvidence =
    bundle.manifest.kind === "review"
      ? ([
          ["diff-manifest", "diff manifest"],
          ["validation", "validation results"],
          ["publication-plan", "publication plan"],
        ] as const)
      : [];
  const missingEvidence: string[] = requiredEvidence
    .filter(([kind]) => !evidenceKinds.has(kind))
    .map(([, label]) => label);
  if (bundle.manifest.capture.completeness === "partial") missingEvidence.push("complete capture");
  const loggedPublicationFailures = sumLogField(
    bundle.logs.filter((log) => log.event.includes("publication")),
    "errors",
  );

  return {
    formatVersion: 1,
    executionId: bundle.manifest.executionId,
    criticalPath,
    phaseDurations,
    agentRetryAttempts: bundle.spans.filter((span) => span.name === "pipr.agent.retry").length,
    modelRetryAttempts: bundle.spans.filter(
      (span) => span.name === "gen_ai.chat" && span.attributes["pipr.attempt.type"] === "retry",
    ).length,
    backoffDurationsMs: bundle.spans
      .filter((span) => span.name === "pipr.agent.retry")
      .flatMap((span) => {
        const durationMs = optionalNumberAttribute(span, "pipr.retry.backoff_ms");
        return durationMs === undefined ? [] : [durationMs];
      }),
    repairAttempts: bundle.manifest.artifacts.filter(
      (artifact) => artifact.kind === "prompt" && /-repair\./.test(artifact.path),
    ).length,
    ...(minimumDuration(bundle.spans, "gen_ai.time_to_first_token") === undefined
      ? {}
      : { timeToFirstTokenMs: minimumDuration(bundle.spans, "gen_ai.time_to_first_token") }),
    toolDurations,
    usage,
    resources: bundle.manifest.resources,
    validationDrops: sumLogField(bundle.logs, "droppedFindings"),
    publicationFailures:
      loggedPublicationFailures > 0
        ? loggedPublicationFailures
        : bundle.manifest.failureCategory === "publication"
          ? 1
          : 0,
    missingEvidence,
  };
}

function recordFromManifest(manifest: RunBundleManifest): RunRecord {
  return {
    executionId: manifest.executionId,
    ...(manifest.workId ? { workId: manifest.workId } : {}),
    kind: manifest.kind,
    outcome: manifest.outcome,
    startedAt: manifest.startedAt,
    ...(manifest.endedAt ? { endedAt: manifest.endedAt } : {}),
    ...(manifest.durationMs === undefined ? {} : { durationMs: manifest.durationMs }),
    ...(manifest.repository ? { repository: manifest.repository } : {}),
    ...(manifest.provider ? { provider: manifest.provider } : {}),
    state: "available",
    source: "filesystem",
    ...(manifest.provider?.runUrl ? { nativeUrl: manifest.provider.runUrl } : {}),
    ref: { executionId: manifest.executionId },
  };
}

function matchesQuery(record: RunRecord, query: RunQuery): boolean {
  return [
    optionalMatch(query.executionId, record.executionId),
    optionalMatch(query.host, record.repository?.host),
    optionalMatch(query.repository, record.repository?.repository),
    optionalMatch(query.changeNumber, record.repository?.changeNumber),
    query.kind === "all" || optionalMatch(query.kind, record.kind),
    statusMatches(query.status, record),
  ].every(Boolean);
}

function optionalMatch<T>(expected: T | undefined, actual: T | undefined): boolean {
  return expected === undefined || actual === expected;
}

function statusMatches(status: RunQuery["status"], record: RunRecord): boolean {
  return status === undefined || record.state === status || record.outcome === status;
}

async function listBundleFiles(directory: string, relative = ""): Promise<Set<string>> {
  const files = new Set<string>();
  for (const entry of await readdir(path.join(directory, relative), { withFileTypes: true })) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Run bundle contains symlink: ${child}`);
    if (entry.isDirectory()) {
      const nested = await listBundleFiles(directory, child);
      for (const file of nested) files.add(file);
      continue;
    }
    if (!entry.isFile()) throw new Error(`Run bundle contains unsupported entry: ${child}`);
    files.add(child);
  }
  return files;
}

async function requireRealDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (details.isSymbolicLink())
    throw new Error(`Run bundle directory cannot be a symlink: ${directory}`);
  if (!details.isDirectory()) throw new Error(`Run bundle path is not a directory: ${directory}`);
}

async function ensureNewDestination(directory: string): Promise<void> {
  try {
    await lstat(directory);
    throw new Error(`Run download destination already exists: ${directory}`);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await mkdir(directory, { recursive: false, mode: 0o700 });
}

function parseJsonLines<T>(contents: string, parse: (value: unknown) => T): T[] {
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parse(JSON.parse(line)));
}

function compareSpans(left: RunSpanRecord, right: RunSpanRecord): number {
  return left.startedAt.localeCompare(right.startedAt) || left.name.localeCompare(right.name);
}

function spanSummary(span: RunSpanRecord & { durationMs: number }) {
  return { name: span.name, durationMs: span.durationMs, status: span.status };
}

function stringAttribute(span: RunSpanRecord, key: string): string | undefined {
  const value = span.attributes[key];
  return typeof value === "string" ? value : undefined;
}

function numberAttribute(span: RunSpanRecord, key: string): number {
  const value = span.attributes[key];
  return typeof value === "number" ? value : 0;
}

function optionalNumberAttribute(span: RunSpanRecord, key: string): number | undefined {
  const value = span.attributes[key];
  return typeof value === "number" ? value : undefined;
}

function minimumDuration(spans: RunSpanRecord[], name: string): number | undefined {
  const durations = spans
    .filter((span) => span.name === name && span.durationMs !== undefined)
    .map((span) => span.durationMs as number);
  return durations.length === 0 ? undefined : Math.min(...durations);
}

function sumLogField(logs: RunLogRecord[], field: string): number {
  return logs.reduce((sum, log) => {
    const value = log.fields[field];
    return sum + (typeof value === "number" ? value : 0);
  }, 0);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readStoreEntries(
  rootDirectory: string,
): Promise<import("node:fs").Dirent<string>[]> {
  try {
    await requireRealDirectory(rootDirectory);
    return await readdir(rootDirectory, { withFileTypes: true, encoding: "utf8" });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function readStoredRecord(rootDirectory: string, executionId: string): Promise<RunRecord> {
  const directory = path.join(rootDirectory, executionId);
  try {
    return recordFromManifest((await loadValidatedRunBundle(directory)).manifest);
  } catch {
    const active = await readActiveCaptureMarker(path.join(directory, "active.json"));
    return {
      executionId,
      ...(active?.startedAt ? { startedAt: active.startedAt } : {}),
      state: active?.active ? "in-progress" : "capture-failed",
      source: "filesystem",
      ref: { executionId },
    };
  }
}

async function validateBundleFileSet(
  directory: string,
  manifest: RunBundleManifest,
): Promise<Set<string>> {
  const expected = new Set(bundleFilePaths(manifest));
  const actual = await listBundleFiles(directory);
  const unexpected = [...actual].find((file) => !expected.has(file));
  if (unexpected) throw new Error(`Run bundle contains unexpected file: ${unexpected}`);
  const missing = [...expected].find((file) => !actual.has(file));
  if (missing) throw new Error(`Run bundle is missing expected file: ${missing}`);
  return actual;
}

async function validateBundleSize(
  directory: string,
  files: Set<string>,
  limitBytes: number,
): Promise<void> {
  let totalBytes = 0;
  for (const file of files) {
    totalBytes += (await stat(path.join(directory, file))).size;
    if (totalBytes > limitBytes) {
      throw new Error(`Run bundle exceeds its ${limitBytes} byte bundle limit`);
    }
  }
}

async function validateArtifacts(directory: string, manifest: RunBundleManifest): Promise<void> {
  for (const artifact of manifest.artifacts) {
    if (artifact.omitted) continue;
    const contents = await readFile(path.join(directory, artifact.path));
    if (contents.byteLength !== artifact.sizeBytes) {
      throw new Error(`Run artifact size mismatch: ${artifact.path}`);
    }
    const hash = createHash("sha256").update(contents).digest("hex");
    if (hash !== artifact.sha256) throw new Error(`Run artifact hash mismatch: ${artifact.path}`);
  }
}

async function loadSignals(directory: string, manifest: RunBundleManifest) {
  const spans = parseJsonLines(
    await readFile(path.join(directory, manifest.signals.spans), "utf8"),
    (value) => runSpanRecordSchema.parse(value),
  );
  const logs = parseJsonLines(
    await readFile(path.join(directory, manifest.signals.logs), "utf8"),
    (value) => runLogRecordSchema.parse(value),
  );
  const metrics = runMetricsSnapshotSchema.parse(
    JSON.parse(await readFile(path.join(directory, manifest.signals.metrics), "utf8")),
  );
  return { spans, logs, metrics };
}

function validateSignalIdentity(
  executionId: string,
  spans: RunSpanRecord[],
  logs: RunLogRecord[],
): void {
  if (spans.some((span) => span.traceId !== executionId)) {
    throw new Error("Run span trace ID does not match execution ID");
  }
  if (logs.some((log) => log.traceId !== executionId)) {
    throw new Error("Run log trace ID does not match execution ID");
  }
}
