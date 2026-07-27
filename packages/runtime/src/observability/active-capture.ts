import { readFile } from "node:fs/promises";

export const currentProcessIdentity = `${process.pid}:${Date.now() - Math.round(process.uptime() * 1000)}`;
export const activeCaptureHeartbeatMilliseconds = 30_000;
const activeCaptureLeaseMilliseconds = 120_000;

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
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
