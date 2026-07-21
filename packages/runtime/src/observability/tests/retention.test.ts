import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { enforceRunStoreRetention } from "../../index.js";
import { currentProcessIdentity, readActiveCaptureMarker } from "../retention-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("run store retention", () => {
  it("deletes expired runs first, then oldest completed runs, and never active runs", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-retention-"));
    temporaryDirectories.push(root);
    await writeFinishedRun(root, "1".repeat(32), "2026-06-01T00:00:00.000Z", 300);
    await writeFinishedRun(root, "2".repeat(32), "2026-07-18T00:00:00.000Z", 300);
    await writeFinishedRun(root, "3".repeat(32), "2026-07-19T00:00:00.000Z", 300);
    await mkdir(path.join(root, "4".repeat(32)), { recursive: true });
    await writeFile(
      path.join(root, "4".repeat(32), "active.json"),
      JSON.stringify({
        executionId: "4".repeat(32),
        startedAt: "2026-07-20T00:00:00.000Z",
        pid: process.pid,
        processIdentity: currentProcessIdentity,
        heartbeatAt: new Date().toISOString(),
      }),
    );
    await writeFile(path.join(root, "4".repeat(32), "active-data"), "x".repeat(500));

    const result = await enforceRunStoreRetention({
      rootDirectory: root,
      retentionDays: 14,
      maxBytes: 1_700,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result.expired).toEqual(["1".repeat(32)]);
    expect(result.quota).toEqual(["2".repeat(32)]);
    expect(await directoryExists(path.join(root, "3".repeat(32)))).toBe(true);
    expect(await directoryExists(path.join(root, "4".repeat(32)))).toBe(true);
  });

  it("includes failed partial captures in quota cleanup", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-retention-"));
    temporaryDirectories.push(root);
    const executionId = "5".repeat(32);
    await mkdir(path.join(root, executionId));
    await writeFile(path.join(root, executionId, "partial.log"), "x".repeat(1_000));

    const result = await enforceRunStoreRetention({
      rootDirectory: root,
      retentionDays: 14,
      maxBytes: 100,
    });

    expect(result.quota).toEqual([executionId]);
    expect(await directoryExists(path.join(root, executionId))).toBe(false);
  });

  it("treats active markers from dead processes as orphaned partial captures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-retention-"));
    temporaryDirectories.push(root);
    const executionId = "6".repeat(32);
    const directory = path.join(root, executionId);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "active.json"),
      JSON.stringify({
        executionId,
        startedAt: "2026-07-01T00:00:00.000Z",
        pid: 2_147_483_647,
      }),
    );
    await writeFile(path.join(directory, "partial.log"), "x".repeat(1_000));

    const result = await enforceRunStoreRetention({
      rootDirectory: root,
      retentionDays: 14,
      maxBytes: 100,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result.quota).toEqual([executionId]);
    expect(await directoryExists(directory)).toBe(false);
  });

  it("treats a reused current PID with a stale process identity as inactive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-retention-"));
    temporaryDirectories.push(root);
    const executionId = "7".repeat(32);
    const directory = path.join(root, executionId);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "active.json"),
      JSON.stringify({
        executionId,
        startedAt: "2026-07-01T00:00:00.000Z",
        pid: process.pid,
        processIdentity: "stale-process",
      }),
    );
    await writeFile(path.join(directory, "partial.log"), "x".repeat(1_000));

    const result = await enforceRunStoreRetention({
      rootDirectory: root,
      retentionDays: 14,
      maxBytes: 100,
      now: new Date("2026-07-20T00:00:00.000Z"),
    });

    expect(result.quota).toEqual([executionId]);
    expect(await directoryExists(directory)).toBe(false);
  });

  it("treats a live foreign PID with a stale lease as inactive", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-retention-"));
    temporaryDirectories.push(root);
    const activePath = path.join(root, "active.json");
    await writeFile(
      activePath,
      JSON.stringify({
        executionId: "8".repeat(32),
        startedAt: "2026-07-01T00:00:00.000Z",
        heartbeatAt: "2026-07-01T00:00:00.000Z",
        pid: 1,
        processIdentity: "foreign-process",
      }),
    );

    expect(
      await readActiveCaptureMarker(activePath, new Date("2026-07-20T00:00:00.000Z")),
    ).toMatchObject({ active: false });
  });
});

async function writeFinishedRun(
  root: string,
  executionId: string,
  endedAt: string,
  payloadBytes: number,
): Promise<void> {
  const directory = path.join(root, executionId);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "payload"), "x".repeat(payloadBytes));
  await writeFile(
    path.join(directory, "run.json"),
    JSON.stringify({
      formatVersion: 1,
      executionId,
      kind: "review",
      outcome: "succeeded",
      startedAt: endedAt,
      endedAt,
      durationMs: 0,
      pipr: { version: "0.4.3" },
      capture: {
        mode: "metadata",
        completeness: "complete",
        redactionApplied: true,
        truncated: false,
        limitBytes: 67_108_864,
        finalizationTimedOut: false,
        errors: [],
      },
      export: { otlp: "disabled", externalUpload: "not-configured" },
      resources: { runtime: "bun 1.3.14" },
      signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
      artifacts: [],
    }),
  );
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    await readFile(path.join(directory, "run.json"));
    return true;
  } catch {
    try {
      await readFile(path.join(directory, "active.json"));
      return true;
    } catch {
      return false;
    }
  }
}
