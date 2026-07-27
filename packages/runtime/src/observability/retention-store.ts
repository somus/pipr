import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseRunBundleManifest, type RunBundleManifest } from "@usepipr/sdk";
import { readActiveCaptureMarker } from "./active-capture.js";

export type StoredRun = {
  executionId: string;
  directory: string;
  active: boolean;
  manifest?: RunBundleManifest;
  completedAt: number;
  bytes: number;
  removed?: boolean;
};

export async function readStoredRuns(rootDirectory: string): Promise<StoredRun[]> {
  await ensureRealDirectory(rootDirectory);
  const entries = await readdir(rootDirectory, { withFileTypes: true, encoding: "utf8" });
  const runEntries = entries.filter(
    (entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name),
  );
  return await Promise.all(runEntries.map((entry) => readStoredRun(rootDirectory, entry.name)));
}

async function readStoredRun(rootDirectory: string, executionId: string): Promise<StoredRun> {
  const directory = path.join(rootDirectory, executionId);
  const [active, details, manifest, bytes] = await Promise.all([
    activeCaptureExists(path.join(directory, "active.json")),
    stat(directory),
    readStoredManifest(directory),
    directoryBytes(directory),
  ]);
  const timestamp = manifest?.endedAt ?? manifest?.startedAt;
  return {
    executionId,
    directory,
    active,
    ...(manifest ? { manifest } : {}),
    completedAt: timestamp ? Date.parse(timestamp) : details.mtimeMs,
    bytes,
  };
}

async function activeCaptureExists(activePath: string): Promise<boolean> {
  try {
    return (await readActiveCaptureMarker(activePath))?.active ?? false;
  } catch {
    // Retention must not delete a capture whose active marker cannot be read safely.
    return true;
  }
}

async function readStoredManifest(directory: string): Promise<RunBundleManifest | undefined> {
  try {
    return parseRunBundleManifest(
      JSON.parse(await readFile(path.join(directory, "run.json"), "utf8")),
    );
  } catch {
    // Partial captures use their directory mtime for retention and quota ordering.
    return undefined;
  }
}

async function directoryBytes(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, encoding: "utf8" })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Run store contains a symlink: ${target}`);
    if (entry.isDirectory()) bytes += await directoryBytes(target);
    else if (entry.isFile()) bytes += (await stat(target)).size;
  }
  return bytes;
}

async function ensureRealDirectory(directory: string): Promise<void> {
  try {
    const details = await lstat(directory);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Run store must be a real directory: ${directory}`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
