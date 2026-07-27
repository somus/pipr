import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parseRunBundleEnvelope,
  type RunBundleArtifact,
  type RunBundleEnvelope,
  type RunBundleManifest,
  type RunLogRecord,
  type RunSpanRecord,
} from "@usepipr/sdk";
import { Decrypter, Encrypter, generateX25519Identity, identityToRecipient } from "age-encryption";
import { extractRunArchive } from "./archive-extraction.js";
import { createRunBundleTarGz } from "./bundle-archive.js";
import {
  type DownloadedBundle,
  loadValidatedRunBundle,
  type ValidatedRunBundle,
} from "./bundle-validation.js";
import { maximumRunBundleBytes } from "./types.js";

const metadataArchiveName = "metadata.tar.gz";
const diagnosticArchiveName = "diagnostic.tar.gz.age";
const envelopeName = "envelope.json";
const metadataLimitBytes = 4 * 1024 * 1024;
const maximumMetadataArchiveBytes = metadataLimitBytes - 64 * 1024;
const emptySha256 = createHash("sha256").update("").digest("hex");

export type PreparedRunBundlePackage = {
  directory: string;
  envelope: RunBundleEnvelope;
};

export type OpenedRunBundlePackage = {
  envelope: RunBundleEnvelope;
  bundle: ValidatedRunBundle;
  diagnostic: "available" | "locked" | "not-captured" | "encryption-failed" | "size-limit";
};

export async function generateRunBundleIdentity(): Promise<{
  identity: string;
  recipient: string;
}> {
  const identity = await generateX25519Identity();
  return { identity, recipient: await identityToRecipient(identity) };
}

export async function validateRunBundleRecipients(recipients: string[]): Promise<string[]> {
  const normalized = [...new Set(recipients.map((recipient) => recipient.trim()).filter(Boolean))];
  if (normalized.length === 0) return [];
  const encrypter = new Encrypter();
  for (const recipient of normalized) encrypter.addRecipient(recipient);
  return normalized;
}

export function parseRunBundleRecipients(value: string | undefined): string[] {
  return value
    ? [
        ...new Set(
          value
            .split(/[,\n]/)
            .map((recipient) => recipient.trim())
            .filter(Boolean),
        ),
      ]
    : [];
}

export async function prepareRunBundlePackage(options: {
  bundleDirectory: string;
  destinationRoot: string;
  recipients?: string[];
}): Promise<PreparedRunBundlePackage> {
  const bundle = await loadValidatedRunBundle(options.bundleDirectory);
  const root = path.resolve(options.destinationRoot);
  await ensureSafeDirectory(root);
  const destination = path.join(root, bundle.manifest.executionId);
  await rejectExistingPath(destination);
  const temporaryPackage = await mkdtemp(path.join(root, ".pipr-package-"));
  const temporaryMetadata = await mkdtemp(path.join(os.tmpdir(), "pipr-run-metadata-"));
  try {
    await writeMetadataProjection(bundle, temporaryMetadata);
    const metadataArchive = await createRunBundleTarGz(temporaryMetadata);
    if (metadataArchive.byteLength > maximumMetadataArchiveBytes) {
      throw new Error("Public Run Bundle metadata exceeds the 4 MiB limit");
    }
    await writePrivate(path.join(temporaryPackage, metadataArchiveName), metadataArchive);

    const recipients =
      bundle.manifest.capture.mode === "diagnostic"
        ? await validateRunBundleRecipients(options.recipients ?? [])
        : [];
    const diagnosticResult = await encryptedDiagnostic(bundle, recipients);
    if (diagnosticResult.ciphertext) {
      await writePrivate(
        path.join(temporaryPackage, diagnosticArchiveName),
        diagnosticResult.ciphertext,
      );
    }
    const envelope = runBundleEnvelope(
      bundle.manifest.executionId,
      metadataArchive,
      diagnosticResult,
    );
    await writePrivate(
      path.join(temporaryPackage, envelopeName),
      Buffer.from(`${JSON.stringify(envelope, null, 2)}\n`),
    );
    await validateRunBundlePackage(temporaryPackage);
    await makePackageProviderReadable(temporaryPackage, envelope);
    await rename(temporaryPackage, destination);
    return { directory: destination, envelope };
  } finally {
    await rm(temporaryMetadata, { recursive: true, force: true });
    await rm(temporaryPackage, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function openRunBundlePackage(options: {
  packageDirectory: string;
  destination: string;
  identities?: string[];
}): Promise<OpenedRunBundlePackage> {
  const envelope = await validateRunBundlePackage(options.packageDirectory);
  if (envelope.protection === "age" && options.identities?.length) {
    const ciphertext = await readFile(path.join(options.packageDirectory, diagnosticArchiveName));
    const decrypter = new Decrypter();
    for (const identity of options.identities) decrypter.addIdentity(identity.trim());
    const diagnosticArchive = await decrypter.decrypt(ciphertext);
    const downloaded = await extractRunArchive({
      archive: diagnosticArchive,
      format: "tar.gz",
      destination: options.destination,
    });
    requireExecutionId(downloaded.manifest.executionId, envelope.executionId);
    return {
      envelope,
      bundle: await loadValidatedRunBundle(downloaded.directory),
      diagnostic: "available",
    };
  }
  const metadataArchive = await readFile(path.join(options.packageDirectory, metadataArchiveName));
  const downloaded = await extractRunArchive({
    archive: metadataArchive,
    format: "tar.gz",
    destination: options.destination,
  });
  requireExecutionId(downloaded.manifest.executionId, envelope.executionId);
  const bundle = await loadValidatedRunBundle(downloaded.directory);
  validatePublicMetadata(bundle);
  return {
    envelope,
    bundle,
    diagnostic: envelope.protection === "age" ? "locked" : envelope.diagnosticState,
  };
}

export async function copyRunBundlePackage(
  source: string,
  destination: string,
): Promise<DownloadedBundle> {
  const envelope = await validateRunBundlePackage(source);
  await rejectExistingPath(destination);
  try {
    const packageDirectory = path.join(destination, "package");
    await mkdir(packageDirectory, { recursive: true, mode: 0o700 });
    for (const file of packageFileNames(envelope)) {
      const target = path.join(packageDirectory, file);
      await copyFile(path.join(source, file), target);
      await chmod(target, 0o600);
    }
    const opened = await openRunBundlePackage({
      packageDirectory,
      destination: path.join(destination, "metadata"),
    });
    return {
      directory: opened.bundle.directory,
      manifest: opened.bundle.manifest,
      envelope,
      packageDirectory,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}

async function encryptedDiagnostic(
  bundle: ValidatedRunBundle,
  recipients: string[],
): Promise<
  | { state: "available"; ciphertext: Uint8Array }
  | { state: "not-captured" | "encryption-failed" | "size-limit"; ciphertext?: undefined }
> {
  if (recipients.length === 0) return { state: "not-captured" };
  const archive = await createRunBundleTarGz(bundle.directory);
  try {
    const encrypter = new Encrypter();
    for (const recipient of recipients) encrypter.addRecipient(recipient);
    const ciphertext = await encrypter.encrypt(archive);
    if (ciphertext.byteLength + metadataLimitBytes > maximumRunBundleBytes) {
      return { state: "size-limit" };
    }
    return { state: "available", ciphertext };
  } catch {
    return { state: "encryption-failed" };
  }
}

function runBundleEnvelope(
  executionId: string,
  metadata: Uint8Array,
  diagnostic:
    | { state: "available"; ciphertext: Uint8Array }
    | { state: "not-captured" | "encryption-failed" | "size-limit"; ciphertext?: undefined },
): RunBundleEnvelope {
  return parseRunBundleEnvelope({
    formatVersion: 1,
    executionId,
    protection: diagnostic.state === "available" ? "age" : "metadata",
    diagnosticState: diagnostic.state,
    metadata: descriptor(metadataArchiveName, "application/gzip", metadata),
    ...(diagnostic.ciphertext
      ? {
          diagnostic: descriptor(diagnosticArchiveName, "application/age", diagnostic.ciphertext),
        }
      : {}),
  });
}

function descriptor(
  archivePath: string,
  mediaType: "application/gzip" | "application/age",
  contents: Uint8Array,
) {
  return {
    path: archivePath,
    mediaType,
    sizeBytes: contents.byteLength,
    sha256: createHash("sha256").update(contents).digest("hex"),
  };
}

async function writeMetadataProjection(
  bundle: ValidatedRunBundle,
  destination: string,
): Promise<void> {
  const artifacts = bundle.manifest.artifacts
    .map(publicArtifactDescriptor)
    .filter((artifact): artifact is RunBundleArtifact => artifact !== undefined);
  let truncated = bundle.manifest.capture.truncated;
  const manifest: RunBundleManifest = {
    ...bundle.manifest,
    capture: {
      ...bundle.manifest.capture,
      mode: "metadata",
      redactionApplied: true,
      errors: [],
    },
    artifacts,
  };
  while (Buffer.byteLength(JSON.stringify(manifest)) > 256 * 1024 && manifest.artifacts.length) {
    manifest.artifacts.shift();
    truncated = true;
  }
  const allSpans = bundle.spans
    .map(publicSpan)
    .filter((span): span is RunSpanRecord => Boolean(span));
  const allLogs = bundle.logs.map(publicLog).filter((log): log is RunLogRecord => Boolean(log));
  const spans = takeLastJsonLines(allSpans, 1536 * 1024);
  const logs = takeLastJsonLines(allLogs, 512 * 1024);
  if (spans.length !== allSpans.length || logs.length !== allLogs.length) truncated = true;
  manifest.capture.truncated = truncated;
  await Promise.all([
    writePrivate(path.join(destination, "run.json"), Buffer.from(`${JSON.stringify(manifest)}\n`)),
    writePrivate(
      path.join(destination, manifest.signals.spans),
      Buffer.from(
        spans.map((span) => JSON.stringify(span)).join("\n") + (spans.length ? "\n" : ""),
      ),
    ),
    writePrivate(
      path.join(destination, manifest.signals.logs),
      Buffer.from(logs.map((log) => JSON.stringify(log)).join("\n") + (logs.length ? "\n" : "")),
    ),
    writePrivate(
      path.join(destination, manifest.signals.metrics),
      Buffer.from(`${JSON.stringify(bundle.metrics)}\n`),
    ),
  ]);
  validatePublicMetadata(await loadValidatedRunBundle(destination));
}

function takeLastJsonLines<T>(records: T[], limitBytes: number): T[] {
  const selected: T[] = [];
  let bytes = 0;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record === undefined) continue;
    const size = Buffer.byteLength(`${JSON.stringify(record)}\n`);
    if (bytes + size > limitBytes) break;
    selected.push(record);
    bytes += size;
  }
  return selected.reverse();
}

function publicArtifactDescriptor(
  artifact: RunBundleArtifact,
  index: number,
): RunBundleArtifact | undefined {
  const originalSizeBytes = artifact.originalSizeBytes ?? artifact.sizeBytes;
  if (originalSizeBytes === 0) return undefined;
  return {
    ...artifact,
    path: `artifacts/${artifact.kind}-${index + 1}.omitted`,
    mediaType: publicMediaType(artifact.mediaType),
    sizeBytes: 0,
    sha256: emptySha256,
    truncated: true,
    originalSizeBytes,
    originalSha256: artifact.originalSha256 ?? artifact.sha256,
    omitted: true,
  };
}

function publicMediaType(mediaType: string): string {
  return new Set([
    "application/json",
    "application/octet-stream",
    "text/markdown",
    "text/plain",
  ]).has(mediaType)
    ? mediaType
    : "application/octet-stream";
}

const publicSpanAttributes = new Set([
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.operation.name",
  "gen_ai.agent.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.tool.name",
  "pipr.attempt.type",
  "pipr.attempt.id",
  "pipr.attempt.number",
  "pipr.agent.name",
  "pipr.provider.name",
  "pipr.model.name",
  "pipr.task.name",
  "pipr.auth.mode",
  "pipr.declarationCount",
  "pipr.fileCount",
  "pipr.limit",
  "pipr.process.exit_code",
  "pipr.prompt.bytes",
  "pipr.resource.cpu_system_ms",
  "pipr.resource.cpu_user_ms",
  "pipr.resource.peak_rss_bytes",
  "pipr.response.stderr_bytes",
  "pipr.response.stdout_bytes",
  "pipr.retry.backoff_ms",
  "pipr.run.failure_category",
  "pipr.run.kind",
  "pipr.run.outcome",
  "pipr.shard.count",
  "pipr.shard.index",
  "pipr.shard.kind",
  "pipr.structural.status",
  "pipr.structural.version",
  "pipr.task.findings",
  "pipr.task.order",
  "pipr.task.repair_attempted",
  "pipr.tool.input_bytes",
  "pipr.tool.input_hash",
  "pipr.tool.output_bytes",
  "pipr.tool.output_hash",
  "pipr.usage.cost_usd",
  "pipr.used",
]);

const publicSpanNames = new Set([
  "gen_ai.chat",
  "gen_ai.execute_tool",
  "gen_ai.time_to_first_token",
  "pipr.agent.attempt_resources",
  "pipr.agent.compaction",
  "pipr.agent.retry",
  "pipr.agent.run_budget",
  "pipr.change.load",
  "pipr.command.check_permission",
  "pipr.config.fetch_trusted_base",
  "pipr.config.load_trusted",
  "pipr.diff.construct",
  "pipr.diff.sharding",
  "pipr.diff.structural_analysis",
  "pipr.event.parse",
  "pipr.pipr_host_run",
  "pipr.prior_state.load_main_comment",
  "pipr.prior_state.load_review",
  "pipr.prior_state.load_threads",
  "pipr.publish.review",
  "pipr.publish.review_progress",
  "pipr.publish.verifier_thread_actions",
  "pipr.review.validate",
  "pipr.run",
  "pipr.task",
  "pipr.workspace.checkout_head",
  "pipr.workspace.prepare",
]);

function publicSpan(span: RunSpanRecord): RunSpanRecord | undefined {
  if (!publicSpanNames.has(span.name)) return undefined;
  return {
    ...span,
    attributes: Object.fromEntries(
      Object.entries(span.attributes).filter(
        ([key, value]) =>
          publicSpanAttributes.has(key) &&
          (typeof value === "number" || typeof value === "boolean" || typeof value === "string"),
      ),
    ),
  };
}

const publicLogEvents = new Set([
  "agent run budget",
  "check finalization after failure failed",
  "command dispatch",
  "command terminal status publication failed",
  "config warning",
  "diff manifest",
  "diff manifest sharded",
  "diff structural analysis",
  "dispatch",
  "event",
  "event dispatch",
  "event ignored",
  "host run start",
  "local dispatch",
  "pi run",
  "pi start",
  "publication plan",
  "publication result",
  "review progress failure publication failed",
  "review progress publication is not available for this code host",
  "review validated",
  "review work progress publication failed",
  "run capture artifact failed",
  "task failed",
  "task ok",
  "task start",
  "trusted config",
  "verifier publication",
  "verifier start",
]);

const publicLogPhases = new Set([
  "check command permission",
  "checkout head",
  "fetch trusted base",
  "load change request",
  "load trusted config",
  "parse event",
  "publish verifier thread actions",
  "workspace",
]);

const publicStringLogFields = new Set([
  "agent",
  "attemptId",
  "attemptType",
  "authMode",
  "failureCategory",
  "host",
  "kind",
  "model",
  "outcome",
  "provider",
  "status",
  "task",
]);

const publicNumericLogFields = new Set([
  "agentRunCount",
  "attemptNumber",
  "backoffMs",
  "costUsd",
  "declarationCount",
  "droppedFindings",
  "durationMs",
  "excludedCount",
  "exitCode",
  "fileCount",
  "findings",
  "inputTokens",
  "limit",
  "outputTokens",
  "promptBytes",
  "rangeCount",
  "retries",
  "shardCount",
  "shardIndex",
  "stderrBytes",
  "stdoutBytes",
  "used",
]);

function publicLog(log: RunLogRecord): RunLogRecord | undefined {
  const phaseMatch = /^(.+) (?:start|ok|failed)$/.exec(log.event);
  const phaseEvent = Boolean(phaseMatch?.[1] && publicLogPhases.has(phaseMatch[1]));
  if (!phaseEvent && !publicLogEvents.has(log.event)) return undefined;
  return {
    ...log,
    fields: Object.fromEntries(
      Object.entries(log.fields).filter(
        ([key, value]) =>
          (typeof value === "string" && publicStringLogFields.has(key)) ||
          ((typeof value === "number" || typeof value === "boolean") &&
            publicNumericLogFields.has(key)),
      ),
    ),
    text: undefined,
  };
}

function validatePublicMetadata(bundle: ValidatedRunBundle): void {
  if (bundle.manifest.capture.mode !== "metadata") {
    throw new Error("Protected package metadata must use metadata capture mode");
  }
  if (
    bundle.logs.some((log) => {
      const projected = publicLog(log);
      return (
        log.text !== undefined ||
        projected === undefined ||
        JSON.stringify(projected.fields) !== JSON.stringify(log.fields)
      );
    })
  ) {
    throw new Error("Protected package metadata contains unsafe log content");
  }
  if (
    bundle.spans.some((span) => {
      const projected = publicSpan(span);
      return (
        projected === undefined ||
        JSON.stringify(projected.attributes) !== JSON.stringify(span.attributes)
      );
    })
  ) {
    throw new Error("Protected package metadata contains unsafe span content");
  }
  if (bundle.manifest.capture.errors.length > 0) {
    throw new Error("Protected package metadata contains diagnostic capture errors");
  }
  if (bundle.manifest.artifacts.some((artifact) => artifact.omitted !== true)) {
    throw new Error("Protected package metadata contains diagnostic artifact bodies");
  }
}

export async function validateRunBundlePackage(directory: string): Promise<RunBundleEnvelope> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Run Bundle package must be a real directory");
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Run Bundle package contains a non-file entry");
  }
  const envelope = parseRunBundleEnvelope(
    JSON.parse(await readFile(path.join(directory, envelopeName), "utf8")),
  );
  const expected = [...packageFileNames(envelope)].sort();
  const actual = entries.map((entry) => entry.name).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Run Bundle package contains unexpected or missing files");
  }
  await validateDescriptor(directory, envelope.metadata);
  if (envelope.diagnostic) await validateDescriptor(directory, envelope.diagnostic);
  const total = (
    await Promise.all(entries.map((entry) => lstat(path.join(directory, entry.name))))
  ).reduce((sum, entry) => sum + entry.size, 0);
  if (total > maximumRunBundleBytes) throw new Error("Run Bundle package exceeds 64 MiB");
  return envelope;
}

function packageFileNames(envelope: RunBundleEnvelope): string[] {
  return [
    envelopeName,
    metadataArchiveName,
    ...(envelope.diagnostic ? [diagnosticArchiveName] : []),
  ];
}

async function validateDescriptor(
  directory: string,
  descriptor: RunBundleEnvelope["metadata"] | NonNullable<RunBundleEnvelope["diagnostic"]>,
): Promise<void> {
  const contents = await readFile(path.join(directory, descriptor.path));
  if (contents.byteLength !== descriptor.sizeBytes) {
    throw new Error(`Run Bundle package size mismatch for ${descriptor.path}`);
  }
  if (createHash("sha256").update(contents).digest("hex") !== descriptor.sha256) {
    throw new Error(`Run Bundle package hash mismatch for ${descriptor.path}`);
  }
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o755 });
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Run Bundle package root must be a real directory: ${directory}`);
  }
  await chmod(directory, 0o755);
}

async function rejectExistingPath(target: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(`Run Bundle package destination already exists: ${target}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

async function writePrivate(filePath: string, contents: Uint8Array): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600, flag: "wx" });
  await chmod(filePath, 0o600);
}

async function makePackageProviderReadable(
  directory: string,
  envelope: RunBundleEnvelope,
): Promise<void> {
  await Promise.all(
    packageFileNames(envelope).map((file) => chmod(path.join(directory, file), 0o644)),
  );
  await chmod(directory, 0o755);
}

function requireExecutionId(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("Protected package execution ID does not match its envelope");
  }
}
