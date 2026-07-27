import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  parseRunBundleManifest,
  type RunBundleEnvelope,
  type RunBundleManifest,
  type RunLogRecord,
  type RunMetricsSnapshot,
  type RunSpanRecord,
  runLogRecordSchema,
  runMetricsSnapshotSchema,
  runSpanRecordSchema,
} from "@usepipr/sdk";
import { bundleFilePaths } from "./bundle-files.js";

export type DownloadedBundle = {
  directory: string;
  manifest: RunBundleManifest;
  envelope?: RunBundleEnvelope;
  packageDirectory?: string;
  archivePath?: string;
};

export type ValidatedRunBundle = {
  directory: string;
  manifest: RunBundleManifest;
  spans: RunSpanRecord[];
  logs: RunLogRecord[];
  metrics: RunMetricsSnapshot;
};

export async function copyValidatedRunBundle(
  source: string,
  destination: string,
): Promise<DownloadedBundle> {
  const bundle = await loadValidatedRunBundle(source);
  await ensureNewDestination(destination);
  try {
    for (const relativePath of bundleFilePaths(bundle.manifest)) {
      const target = path.join(destination, relativePath);
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(path.join(source, relativePath), target);
    }
    const copied = await loadValidatedRunBundle(destination);
    return { directory: destination, manifest: copied.manifest };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
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

async function requireRealDirectory(directory: string): Promise<void> {
  const details = await lstat(directory);
  if (details.isSymbolicLink()) {
    throw new Error(`Run bundle directory cannot be a symlink: ${directory}`);
  }
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

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

function parseJsonLines<T>(contents: string, parse: (value: unknown) => T): T[] {
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => parse(JSON.parse(line)));
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
