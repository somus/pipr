import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunBundleManifest, RunLogRecord, RunSpanRecord } from "@usepipr/sdk";
import { readActiveCaptureMarker } from "./active-capture.js";
import {
  copyValidatedRunBundle,
  type DownloadedBundle,
  loadValidatedRunBundle,
  type ValidatedRunBundle,
} from "./bundle-validation.js";

export {
  copyValidatedRunBundle,
  type DownloadedBundle,
  loadValidatedRunBundle,
  type ValidatedRunBundle,
} from "./bundle-validation.js";

export type RunRecordState =
  | "available"
  | "in-progress"
  | "expired"
  | "capture-failed"
  | "upload-failed"
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
  protection?: "plaintext" | "metadata" | "age" | "unknown";
  source: "filesystem" | "github";
  nativeUrl?: string;
  error?: string;
  ref: RunRef;
};

export type RunRef = {
  executionId: string;
  providerId?: string;
  archiveUrl?: string;
  preserveArchive?: boolean;
};

export interface RunArchiveSource {
  list(query: RunQuery): Promise<RunRecord[]>;
  download(ref: RunRef, destination: string): Promise<DownloadedBundle>;
}

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
  structuralAnalysis?: {
    status: string;
    reason?: string;
    durationMs: number;
    fileCount: number;
    declarationCount: number;
  };
  agentRunBudget?: { used: number; limit?: number };
  modelAttempts: Array<{
    agent: string;
    task?: string;
    provider: string;
    model: string;
    attemptType: string;
    attemptNumber: number;
    authMode?: string;
    shardIndex?: number;
    shardCount?: number;
    durationMs: number;
    status: RunSpanRecord["status"];
  }>;
  failures: Array<{ event: string; task?: string; message: string }>;
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
    if (await packageEnvelopeExists(source)) {
      const { copyRunBundlePackage } = await import("./protected-package.js");
      return await copyRunBundlePackage(source, destination);
    }
    return await copyValidatedRunBundle(source, destination);
  }
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
  const structuralSpan = timedSpans.find((span) => span.name === "pipr.diff.structural_analysis");
  const budgetSpan = bundle.spans.find((span) => span.name === "pipr.agent.run_budget");
  const modelAttempts = timedSpans
    .filter((span) => span.name === "gen_ai.chat")
    .sort(compareSpans)
    .map(modelAttemptDiagnosis);

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
    ...(structuralSpan
      ? {
          structuralAnalysis: {
            status: stringAttribute(structuralSpan, "pipr.structural.status") ?? "unknown",
            ...(stringAttribute(structuralSpan, "pipr.structural.reason")
              ? { reason: stringAttribute(structuralSpan, "pipr.structural.reason") }
              : {}),
            durationMs: structuralSpan.durationMs,
            fileCount: numberAttribute(structuralSpan, "pipr.fileCount"),
            declarationCount: numberAttribute(structuralSpan, "pipr.declarationCount"),
          },
        }
      : {}),
    ...(budgetSpan
      ? {
          agentRunBudget: {
            used: numberAttribute(budgetSpan, "pipr.used"),
            ...(optionalNumberAttribute(budgetSpan, "pipr.limit") === undefined
              ? {}
              : { limit: optionalNumberAttribute(budgetSpan, "pipr.limit") }),
          },
        }
      : {}),
    modelAttempts,
    failures: diagnosticFailures(bundle.logs),
    missingEvidence,
  };
}

function modelAttemptDiagnosis(
  span: RunSpanRecord & { durationMs: number },
): RunDiagnosis["modelAttempts"][number] {
  return {
    agent: stringAttribute(span, "gen_ai.agent.name") ?? "unknown",
    ...(stringAttribute(span, "pipr.task.name")
      ? { task: stringAttribute(span, "pipr.task.name") }
      : {}),
    provider: stringAttribute(span, "gen_ai.provider.name") ?? "unknown",
    model: stringAttribute(span, "gen_ai.request.model") ?? "unknown",
    attemptType: stringAttribute(span, "pipr.attempt.type") ?? "unknown",
    attemptNumber: numberAttribute(span, "pipr.attempt.number"),
    ...(stringAttribute(span, "pipr.auth.mode")
      ? { authMode: stringAttribute(span, "pipr.auth.mode") }
      : {}),
    ...(optionalNumberAttribute(span, "pipr.shard.index") === undefined
      ? {}
      : { shardIndex: optionalNumberAttribute(span, "pipr.shard.index") }),
    ...(optionalNumberAttribute(span, "pipr.shard.count") === undefined
      ? {}
      : { shardCount: optionalNumberAttribute(span, "pipr.shard.count") }),
    durationMs: span.durationMs,
    status: span.status,
  };
}

function diagnosticFailures(logs: RunLogRecord[]): RunDiagnosis["failures"] {
  return logs
    .filter((log) => log.level === "error" && typeof log.fields.error === "string")
    .slice(0, 20)
    .map((log) => ({
      event: log.event,
      ...(typeof log.fields.task === "string" ? { task: log.fields.task } : {}),
      message: diagnosticFailureMessage(log.event, log.fields.error as string),
    }));
}

function diagnosticFailureMessage(event: string, error: string): string {
  if (/agent-call budget exhausted/i.test(error)) {
    return "Review Run agent-call budget exhausted";
  }
  if (/missing secret env var/i.test(error)) {
    return "Required secret environment variable is missing";
  }
  if (/timed out|timeout/i.test(error)) {
    return "Operation timed out";
  }
  if (/stale head|head (?:sha )?(?:changed|mismatch)/i.test(error)) {
    return "Change request head changed before publication";
  }
  if (/publish|publication/i.test(event) || /publish|publication/i.test(error)) {
    return "Publication failed";
  }
  return "Task failed; download the redacted bundle for details";
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
    protection: "plaintext",
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

async function requireRealDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (details.isSymbolicLink())
    throw new Error(`Run bundle directory cannot be a symlink: ${directory}`);
  if (!details.isDirectory()) throw new Error(`Run bundle path is not a directory: ${directory}`);
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
  } catch (bundleError) {
    if (!(await packageEnvelopeExists(directory))) {
      return await failedStoredRecord(directory, executionId, bundleError);
    }
    try {
      return await packagedStoredRecord(directory);
    } catch (packageError) {
      return await failedStoredRecord(directory, executionId, packageError);
    }
  }
}

async function packageEnvelopeExists(directory: string): Promise<boolean> {
  try {
    await lstat(path.join(directory, "envelope.json"));
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
}

async function packagedStoredRecord(directory: string): Promise<RunRecord> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-package-record-"));
  try {
    const { openRunBundlePackage, validateRunBundlePackage } = await import(
      "./protected-package.js"
    );
    const envelope = await validateRunBundlePackage(directory);
    const opened = await openRunBundlePackage({
      packageDirectory: directory,
      destination: path.join(temporaryRoot, "metadata"),
    });
    return {
      ...recordFromManifest(opened.bundle.manifest),
      protection: envelope.protection,
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function failedStoredRecord(
  directory: string,
  executionId: string,
  bundleError: unknown,
): Promise<RunRecord> {
  const { active, error: activeMarkerError } = await storedActiveCapture(directory);
  if (active?.active) {
    return {
      executionId,
      ...(active.startedAt ? { startedAt: active.startedAt } : {}),
      state: "in-progress",
      source: "filesystem",
      ref: { executionId },
    };
  }
  const errors = [runRecordErrorMessage(bundleError, directory)];
  if (activeMarkerError) errors.push(`Active capture marker unreadable: ${activeMarkerError}`);
  return {
    executionId,
    ...(active?.startedAt ? { startedAt: active.startedAt } : {}),
    state: "capture-failed",
    source: "filesystem",
    error: errors.join("; "),
    ref: { executionId },
  };
}

async function storedActiveCapture(directory: string): Promise<{
  active?: Awaited<ReturnType<typeof readActiveCaptureMarker>>;
  error?: string;
}> {
  try {
    return { active: await readActiveCaptureMarker(path.join(directory, "active.json")) };
  } catch (error) {
    return { error: runRecordErrorMessage(error, directory) };
  }
}

function runRecordErrorMessage(error: unknown, directory: string): string {
  const message = error instanceof Error ? error.message : "Unknown run bundle validation failure";
  return message.replaceAll(directory, "<bundle>").slice(0, 1000);
}
