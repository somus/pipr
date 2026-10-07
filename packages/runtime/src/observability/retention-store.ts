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

/** Run store subdirectory holding per-change-request agent conversation stores (`<host>/<repo>/<number>`). */
export const agentStoresDirectoryName = "agent-stores";

export async function readStoredRuns(rootDirectory: string): Promise<StoredRun[]> {
  await ensureRealDirectory(rootDirectory);
  const entries = await readdir(rootDirectory, { withFileTypes: true, encoding: "utf8" });
  const runEntries = entries.filter(
    (entry) => entry.isDirectory() && /^[a-f0-9]{32}$/.test(entry.name),
  );
  return await Promise.all(runEntries.map((entry) => readStoredRun(rootDirectory, entry.name)));
}

/**
 * Agent conversation stores, one retention unit per change request. Their age is their last write, so a change request
 * that keeps receiving pushes keeps its conversations.
 */
export async function readAgentStores(rootDirectory: string): Promise<StoredRun[]> {
  const storesRoot = path.join(rootDirectory, agentStoresDirectoryName);
  const units: StoredRun[] = [];
  for (const host of await subdirectories(storesRoot)) {
    for (const repository of await subdirectories(path.join(storesRoot, host))) {
      for (const change of await subdirectories(path.join(storesRoot, host, repository))) {
        const directory = path.join(storesRoot, host, repository, change);
        const [bytes, lastWrite] = await Promise.all([
          directoryBytes(directory),
          latestModification(directory),
        ]);
        units.push({
          executionId: path.posix.join(agentStoresDirectoryName, host, repository, change),
          directory,
          active: false,
          completedAt: lastWrite,
          bytes,
        });
      }
    }
  }
  return units;
}

async function subdirectories(directory: string): Promise<string[]> {
  try {
    const entries = await readdir(directory, { withFileTypes: true, encoding: "utf8" });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }
}

async function latestModification(directory: string): Promise<number> {
  let latest = (await stat(directory)).mtimeMs;
  for (const entry of await readdir(directory, { withFileTypes: true, encoding: "utf8" })) {
    const target = path.join(directory, entry.name);
    const modified = entry.isDirectory()
      ? await latestModification(target)
      : (await lstat(target)).mtimeMs;
    latest = Math.max(latest, modified);
  }
  return latest;
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
