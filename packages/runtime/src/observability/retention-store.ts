import { lstat, mkdir, readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseRunBundleManifest, type RunBundleManifest } from "@usepipr/sdk";

export const currentProcessIdentity = `${process.pid}:${Date.now() - Math.round(process.uptime() * 1000)}`;
export const activeCaptureHeartbeatMilliseconds = 30_000;
const activeCaptureLeaseMilliseconds = 120_000;

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

export async function readActiveCaptureMarker(
  activePath: string,
  now = new Date(),
): Promise<{ active: boolean; executionId?: string; startedAt?: string } | undefined> {
  try {
    const marker = JSON.parse(await readFile(activePath, "utf8")) as {
      pid?: unknown;
      executionId?: unknown;
      startedAt?: unknown;
      processIdentity?: unknown;
      heartbeatAt?: unknown;
    };
    if (!Number.isInteger(marker.pid) || Number(marker.pid) < 1) return undefined;
    const heartbeatAt =
      typeof marker.heartbeatAt === "string" ? Date.parse(marker.heartbeatAt) : Number.NaN;
    const leaseAge = now.getTime() - heartbeatAt;
    let active =
      Number.isFinite(heartbeatAt) &&
      leaseAge >= 0 &&
      leaseAge <= activeCaptureLeaseMilliseconds &&
      (Number(marker.pid) !== process.pid || marker.processIdentity === currentProcessIdentity);
    if (active) {
      try {
        process.kill(Number(marker.pid), 0);
      } catch (error) {
        active = !(error instanceof Error && "code" in error && error.code === "ESRCH");
      }
    }
    return {
      active,
      ...(typeof marker.executionId === "string" ? { executionId: marker.executionId } : {}),
      ...(typeof marker.startedAt === "string" ? { startedAt: marker.startedAt } : {}),
    };
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    return undefined;
  }
}

async function activeCaptureExists(activePath: string): Promise<boolean> {
  return (await readActiveCaptureMarker(activePath))?.active ?? false;
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
