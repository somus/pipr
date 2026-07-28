import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";
import {
  diagnoseRunBundle,
  FileSystemRunArchiveSource,
  loadValidatedRunBundle,
} from "../archive.js";
import { extractRunArchive } from "../archive-extraction.js";
import { startFileRunRecorder } from "../recorder.js";
import { maximumRunBundleBytes } from "../types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("filesystem run archives", () => {
  it("lists, filters, copies, and validates finalized bundles", async () => {
    const root = await temporaryDirectory();
    const recorder = await completedReview(root, 42);
    const source = new FileSystemRunArchiveSource(root);

    expect(await source.list({ changeNumber: 7 })).toEqual([]);
    const records = await source.list({
      host: "github",
      repository: "somus/pipr",
      changeNumber: 42,
      kind: "review",
      limit: 10,
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      executionId: recorder.executionId,
      kind: "review",
      outcome: "succeeded",
      state: "available",
      source: "filesystem",
    });

    const destination = path.join(await temporaryDirectory(), "downloaded");
    const downloaded = await source.download({ executionId: recorder.executionId }, destination);
    expect(downloaded.directory).toBe(destination);
    expect(downloaded.manifest.executionId).toBe(recorder.executionId);
    expect((await loadValidatedRunBundle(destination)).spans).not.toHaveLength(0);
  });

  it("rejects hash mismatches, symlinks, unexpected files, and oversized bundles", async () => {
    const root = await temporaryDirectory();
    const recorder = await completedReview(root, 42);
    const artifactPath = path.join(recorder.directory, "artifacts", "validation.json");
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.alloc(original.byteLength, "x"));
    await expect(loadValidatedRunBundle(recorder.directory)).rejects.toThrow("hash mismatch");

    const symlinkRecorder = await completedReview(root, 43);
    await symlink("run.json", path.join(symlinkRecorder.directory, "unexpected-link"));
    await expect(loadValidatedRunBundle(symlinkRecorder.directory)).rejects.toThrow("symlink");

    const unexpectedRecorder = await completedReview(root, 44);
    await writeFile(path.join(unexpectedRecorder.directory, "unexpected.txt"), "x");
    await expect(loadValidatedRunBundle(unexpectedRecorder.directory)).rejects.toThrow(
      "unexpected file",
    );

    const oversizedRecorder = await completedReview(root, 45);
    const manifestPath = path.join(oversizedRecorder.directory, "run.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.capture.limitBytes = 1;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await expect(loadValidatedRunBundle(oversizedRecorder.directory)).rejects.toThrow(
      "bundle limit",
    );
  });

  it("reports a dead active marker as a failed partial capture", async () => {
    const root = await temporaryDirectory();
    const executionId = "f".repeat(32);
    const directory = path.join(root, executionId);
    await mkdir(directory);
    await writeFile(
      path.join(directory, "active.json"),
      JSON.stringify({ executionId, pid: 2_147_483_647, startedAt: "2026-07-20T00:00:00Z" }),
    );

    expect(await new FileSystemRunArchiveSource(root).list({})).toEqual([
      expect.objectContaining({ executionId, state: "capture-failed" }),
    ]);
  });

  it("surfaces a sanitized bundle validation failure when listing stored runs", async () => {
    const root = await temporaryDirectory();
    const recorder = await completedReview(root, 46);
    const artifactPath = path.join(recorder.directory, "artifacts", "validation.json");
    const original = await readFile(artifactPath);
    await writeFile(artifactPath, Buffer.alloc(original.byteLength, "x"));

    expect(await new FileSystemRunArchiveSource(root).list({})).toEqual([
      expect.objectContaining({
        executionId: recorder.executionId,
        state: "capture-failed",
        error: "Run artifact hash mismatch: artifacts/validation.json",
      }),
    ]);
  });
});

describe("deterministic run diagnosis", () => {
  it("summarizes phases, retries, repair, tools, usage, drops, failures, and missing evidence", async () => {
    const root = await temporaryDirectory();
    const recorder = await startFileRunRecorder({ rootDirectory: root, env: {} });
    recorder.logSink.log({ level: "info", event: "workspace start", fields: {} });
    recorder.logSink.log({
      level: "info",
      event: "workspace ok",
      fields: { durationMs: 20 },
    });
    recorder.logSink.log({
      level: "warning",
      event: "review validation",
      fields: { droppedFindings: 2 },
    });
    recorder.logSink.log({
      level: "error",
      event: "review publication",
      fields: { errors: 1 },
    });
    recorder.logSink.log({
      level: "info",
      event: "diff structural analysis",
      fields: {
        status: "unavailable",
        reason: "timeout",
        durationMs: 25,
        fileCount: 0,
        declarationCount: 0,
      },
    });
    recorder.logSink.log({
      level: "info",
      event: "agent run budget",
      fields: { used: 4, limit: 4 },
    });
    recorder.logSink.log({
      level: "error",
      event: "task failed",
      fields: {
        task: "review",
        error: "Review Run agent-call budget exhausted at /Users/private/project/file.ts",
      },
    });
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "repair",
      attemptNumber: 2,
      agent: "reviewer",
      provider: "openai",
      model: "gpt-test",
      prompt: "prompt",
    });
    attempt.event({ kind: "retry-start", delayMs: 2_000 });
    attempt.event({ kind: "retry-end" });
    attempt.event({ kind: "tool-start", id: "tool-1", name: "read" });
    attempt.event({ kind: "tool-end", id: "tool-1", name: "read" });
    attempt.event({ kind: "first-response" });
    await attempt.finish({
      output: "output",
      exitCode: 0,
      usage: {
        status: "complete",
        inputTokens: 100,
        outputTokens: 20,
        costUsd: 0.01,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheUsageStatus: "complete",
      },
    });
    recorder.logSink.log({
      level: "info",
      event: "pi start",
      fields: {
        attemptId: "model-retry",
        attemptType: "retry",
        attemptNumber: 3,
        agent: "reviewer",
        provider: "openai",
        model: "gpt-test",
        task: "review",
        shardIndex: 2,
        shardCount: 2,
        authMode: "subscription",
      },
    });
    recorder.logSink.log({
      level: "info",
      event: "pi run",
      fields: {
        attemptId: "model-retry",
        exitCode: 0,
        durationMs: 10,
        inputTokens: 7,
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
        cacheUsageStatus: "complete",
        costUsd: 0.002,
      },
    });
    await recorder.finish({
      kind: "review",
      outcome: "failed",
      failureCategory: "publication",
    });

    const bundle = await loadValidatedRunBundle(recorder.directory);
    const diagnosis = diagnoseRunBundle(bundle);
    expect(diagnosis.phaseDurations).toContainEqual(
      expect.objectContaining({ name: "pipr.workspace.prepare", durationMs: 20 }),
    );
    expect(diagnosis.agentRetryAttempts).toBe(1);
    expect(diagnosis.modelRetryAttempts).toBe(1);
    expect(diagnosis.backoffDurationsMs).toEqual([2_000]);
    expect(diagnosis.repairAttempts).toBe(1);
    expect(diagnosis.toolDurations[0]).toMatchObject({ name: "read", status: "ok" });
    expect(diagnosis.timeToFirstTokenMs).toBeNumber();
    expect(diagnosis.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      cacheReadTokens: 5,
      cacheWriteTokens: 2,
      cacheUsageStatus: "complete",
      costUsd: 0.002,
    });
    expect(diagnosis.validationDrops).toBe(2);
    expect(diagnosis.publicationFailures).toBe(1);
    expect(diagnosis.missingEvidence).toContain("diff manifest");
    expect(diagnosis.structuralAnalysis).toEqual({
      status: "unavailable",
      reason: "timeout",
      durationMs: 25,
      fileCount: 0,
      declarationCount: 0,
    });
    expect(diagnosis.agentRunBudget).toEqual({ used: 4, limit: 4 });
    expect(diagnosis.modelAttempts).toContainEqual(
      expect.objectContaining({
        task: "review",
        shardIndex: 2,
        shardCount: 2,
        authMode: "subscription",
      }),
    );
    expect(diagnosis.failures).toEqual([
      {
        event: "task failed",
        task: "review",
        message: "Review Run agent-call budget exhausted",
      },
    ]);
  });

  it("classifies cache status across every model attempt", async () => {
    const root = await temporaryDirectory();
    const recorder = await completedReview(root, 46);
    const bundle = await loadValidatedRunBundle(recorder.directory);
    const modelSpan = {
      formatVersion: 1 as const,
      traceId: recorder.executionId,
      category: "model" as const,
      startedAt: "2026-07-20T00:00:00.000Z",
      status: "ok" as const,
    };
    bundle.spans = [
      {
        ...modelSpan,
        spanId: "a".repeat(16),
        name: "gen_ai.chat",
        attributes: {
          "pipr.usage.cache_read_tokens": 5,
          "pipr.usage.cache_write_tokens": 2,
          "pipr.usage.cache_status": "complete",
        },
      },
      {
        ...modelSpan,
        spanId: "b".repeat(16),
        name: "gen_ai.chat",
        attributes: {},
      },
    ];
    expect(diagnoseRunBundle(bundle).usage.cacheUsageStatus).toBe("partial");

    const secondSpan = bundle.spans[1];
    if (!secondSpan) throw new Error("expected second model span");
    bundle.spans[1] = {
      ...secondSpan,
      attributes: {
        "pipr.usage.cache_read_tokens": 0,
        "pipr.usage.cache_write_tokens": 0,
        "pipr.usage.cache_status": "unavailable",
      },
    };
    expect(diagnoseRunBundle(bundle).usage.cacheUsageStatus).toBe("partial");

    bundle.spans = [
      {
        ...modelSpan,
        spanId: "c".repeat(16),
        name: "gen_ai.chat",
        attributes: {
          "pipr.usage.cache_read_tokens": 0,
          "pipr.usage.cache_write_tokens": 0,
          "pipr.usage.cache_status": "unavailable",
        },
      },
    ];
    expect(diagnoseRunBundle(bundle).usage.cacheUsageStatus).toBe("unavailable");

    bundle.spans = [
      {
        ...modelSpan,
        spanId: "d".repeat(16),
        name: "gen_ai.chat",
        attributes: {
          "pipr.usage.cache_read_tokens": Number.MAX_SAFE_INTEGER,
          "pipr.usage.cache_write_tokens": 1,
          "pipr.usage.cache_status": "complete",
        },
      },
      {
        ...modelSpan,
        spanId: "e".repeat(16),
        name: "gen_ai.chat",
        attributes: {
          "pipr.usage.cache_read_tokens": 1,
          "pipr.usage.cache_write_tokens": 2,
          "pipr.usage.cache_status": "complete",
        },
      },
    ];
    expect(diagnoseRunBundle(bundle).usage).toMatchObject({
      cacheReadTokens: Number.MAX_SAFE_INTEGER,
      cacheWriteTokens: 3,
      cacheUsageStatus: "partial",
    });
  });
});

describe("run archive extraction", () => {
  it("rejects traversal paths before writing archive entries", async () => {
    const destinationRoot = await temporaryDirectory();
    const destination = path.join(destinationRoot, "bundle");
    const archive = zipSync({ "../outside.txt": strToU8("unsafe") });

    await expect(extractRunArchive({ archive, format: "zip", destination })).rejects.toThrow(
      "unsafe path",
    );
    await expect(readFile(path.join(destinationRoot, "outside.txt"))).rejects.toThrow();
  });

  it("rejects symbolic links encoded in ZIP metadata", async () => {
    const destination = path.join(await temporaryDirectory(), "bundle");
    const archive = zipSync({
      "run.json": [strToU8("target"), { os: 3, attrs: 0o120777 << 16 }],
    });

    await expect(extractRunArchive({ archive, format: "zip", destination })).rejects.toThrow(
      "symbolic link",
    );
  });

  it("bounds ZIP expansion by emitted bytes instead of declared entry sizes", async () => {
    const destination = path.join(await temporaryDirectory(), "bundle");
    const archive = zipSync({ oversized: new Uint8Array(maximumRunBundleBytes + 1) });
    forgeZipOriginalSizes(archive, 1);

    await expect(extractRunArchive({ archive, format: "zip", destination })).rejects.toThrow(
      "expansion exceeds",
    );
  });

  it("bounds emitted ZIP entries when the central-directory count is forged", async () => {
    const destination = path.join(await temporaryDirectory(), "bundle");
    const entries = Object.fromEntries(
      Array.from({ length: 1025 }, (_, index) => [`entry-${index}`, new Uint8Array()]),
    );
    const archive = zipSync(entries);
    forgeZipEntryCount(archive, 1);

    await expect(extractRunArchive({ archive, format: "zip", destination })).rejects.toThrow(
      "too many entries",
    );
  });

  it("bounds tar.gz expansion by emitted bytes", async () => {
    const destination = path.join(await temporaryDirectory(), "bundle");
    const archive = gzipSync(new Uint8Array(maximumRunBundleBytes + 1), { mtime: 0 });

    await expect(extractRunArchive({ archive, format: "tar.gz", destination })).rejects.toThrow(
      "expansion exceeds",
    );
  });

  it("bounds the number of tar.gz entries before writing them all", async () => {
    const destination = path.join(await temporaryDirectory(), "bundle");
    const archive = tarGzEntries(1025);

    await expect(extractRunArchive({ archive, format: "tar.gz", destination })).rejects.toThrow(
      "too many entries",
    );
  });

  it("accepts directory entries in tar.gz archives", async () => {
    const destination = path.join(await temporaryDirectory(), "bundle");

    await expect(
      extractRunArchive({
        archive: tarGzEntry("nested/", "5"),
        format: "tar.gz",
        destination,
      }),
    ).rejects.toThrow("exactly one run.json");
  });

  it("rejects traversal and link entries in tar.gz archives", async () => {
    const root = await temporaryDirectory();
    await expect(
      extractRunArchive({
        archive: tarGzEntry("../outside.txt", "0"),
        format: "tar.gz",
        destination: path.join(root, "traversal"),
      }),
    ).rejects.toThrow("unsafe path");
    await expect(readFile(path.join(root, "outside.txt"))).rejects.toThrow();
    await expect(
      extractRunArchive({
        archive: tarGzEntry("/absolute.txt", "0"),
        format: "tar.gz",
        destination: path.join(root, "absolute"),
      }),
    ).rejects.toThrow("unsafe path");

    for (const type of ["1", "2"]) {
      await expect(
        extractRunArchive({
          archive: tarGzEntry("link", type),
          format: "tar.gz",
          destination: path.join(root, `link-${type}`),
        }),
      ).rejects.toThrow("unsupported link");
    }
    await expect(
      extractRunArchive({
        archive: tarGzEntry("oversized-entry", "0", 2048),
        format: "tar.gz",
        destination: path.join(root, "bounds"),
      }),
    ).rejects.toThrow("archive bounds");
  });
});

function forgeZipOriginalSizes(archive: Uint8Array, size: number): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  view.setUint32(22, size, true);
  for (let offset = 0; offset <= archive.byteLength - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      view.setUint32(offset + 24, size, true);
      return;
    }
  }
  throw new Error("Test ZIP central directory not found");
}

function forgeZipEntryCount(archive: Uint8Array, count: number): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  for (let offset = archive.byteLength - 22; offset >= 0; offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      view.setUint16(offset + 8, count, true);
      view.setUint16(offset + 10, count, true);
      return;
    }
  }
  throw new Error("Test ZIP end record not found");
}

function tarGzEntry(name: string, type: string, declaredBytes = 0): Uint8Array {
  const header = new Uint8Array(512);
  header.set(strToU8(name).subarray(0, 100), 0);
  header.set(strToU8("0000600\0"), 100);
  header.set(strToU8("0000000\0"), 108);
  header.set(strToU8("0000000\0"), 116);
  header.set(strToU8(`${declaredBytes.toString(8).padStart(11, "0")}\0`), 124);
  header.set(strToU8("00000000000\0"), 136);
  header.set(strToU8("        "), 148);
  header[156] = type.charCodeAt(0);
  header.set(strToU8("ustar\x000"), 257);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.set(strToU8(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
  const tar = new Uint8Array(1536);
  tar.set(header);
  return gzipSync(tar, { mtime: 0 });
}

function tarGzEntries(count: number): Uint8Array {
  const tar = new Uint8Array((count + 2) * 512);
  for (let index = 0; index < count; index += 1) {
    const header = new Uint8Array(512);
    header.set(strToU8(`entry-${index}`), 0);
    header.set(strToU8("0000600\0"), 100);
    header.set(strToU8("0000000\0"), 108);
    header.set(strToU8("0000000\0"), 116);
    header.set(strToU8("00000000000\0"), 124);
    header.set(strToU8("00000000000\0"), 136);
    header.set(strToU8("        "), 148);
    header[156] = "0".charCodeAt(0);
    header.set(strToU8("ustar\x000"), 257);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.set(strToU8(`${checksum.toString(8).padStart(6, "0")}\0 `), 148);
    tar.set(header, index * 512);
  }
  return gzipSync(tar, { mtime: 0 });
}

async function completedReview(root: string, changeNumber: number) {
  const recorder = await startFileRunRecorder({ rootDirectory: root, env: {} });
  await recorder.addArtifact({
    kind: "validation",
    name: "validation.json",
    mediaType: "application/json",
    content: JSON.stringify({ droppedFindings: [] }),
    sensitive: true,
  });
  await recorder.finish({
    kind: "review",
    outcome: "succeeded",
    repository: {
      host: "github",
      repository: "somus/pipr",
      changeNumber,
      baseSha: "base",
      headSha: "head",
    },
  });
  return recorder;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-run-archive-"));
  temporaryDirectories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}
