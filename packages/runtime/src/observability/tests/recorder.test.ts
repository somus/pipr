import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRunBundleManifest } from "@usepipr/sdk";
import { loadValidatedRunBundle } from "../archive.js";
import {
  createInMemoryRunRecorder,
  createNoopRunRecorder,
  startFileRunRecorder,
} from "../recorder.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("file run recorder", () => {
  it("bounds log records so finalized bundles remain loadable", async () => {
    const rootDirectory = await temporaryDirectory();
    const recorder = await startFileRunRecorder({ rootDirectory, env: {} });
    recorder.logSink.log({
      level: "error",
      event: "e".repeat(501),
      fields: {
        ["k".repeat(201)]: "v".repeat(2001),
        stack: Array.from({ length: 101 }, () => "s".repeat(2001)),
      },
      text: "t".repeat(65_537),
    });

    await recorder.finish({ kind: "review", outcome: "failed", failureCategory: "capture" });

    const bundle = await loadValidatedRunBundle(recorder.directory);
    expect(bundle.manifest.capture.truncated).toBe(true);
    expect(bundle.logs).toHaveLength(1);
    expect(bundle.logs[0]?.event).toHaveLength(500);
    expect(bundle.logs[0]?.text).toHaveLength(65_536);
    expect(Object.keys(bundle.logs[0]?.fields ?? {})[0]).toHaveLength(200);
    expect(bundle.logs[0]?.fields.stack).toHaveLength(100);
  });

  it("keeps finalized bundle ownership aligned with its configured store", async () => {
    const rootDirectory = await temporaryDirectory();
    const storeOwner = await stat(rootDirectory);
    const recorder = await startFileRunRecorder({ rootDirectory, env: {} });

    await recorder.finish({ kind: "review", outcome: "succeeded" });

    for (const bundlePath of [
      rootDirectory,
      recorder.directory,
      path.join(recorder.directory, "run.json"),
    ]) {
      const bundleOwner = await stat(bundlePath);
      expect({ uid: bundleOwner.uid, gid: bundleOwner.gid }).toEqual({
        uid: storeOwner.uid,
        gid: storeOwner.gid,
      });
    }
  });

  it("provides no-op and in-memory adapters through the recorder interface", async () => {
    const noop = createNoopRunRecorder();
    await noop.addArtifact({
      kind: "other",
      name: "ignored.txt",
      mediaType: "text/plain",
      content: "ignored",
      sensitive: false,
    });
    await noop.finish({ kind: "startup", outcome: "succeeded" });

    const memory = createInMemoryRunRecorder({ executionId: "a".repeat(32) });
    memory.logSink.log({ level: "info", event: "test", fields: {} });
    await memory.addArtifact({
      kind: "other",
      name: "captured.txt",
      mediaType: "text/plain",
      content: "captured",
      sensitive: false,
    });
    await memory.finish({ kind: "review", outcome: "succeeded" });

    expect(noop.executionId).toMatch(/^[a-f0-9]{32}$/);
    expect(memory.capture.logs).toHaveLength(1);
    expect(memory.capture.artifacts).toHaveLength(1);
    expect(memory.capture.result).toEqual({ kind: "review", outcome: "succeeded" });
  });

  it("correlates concurrent model spans by attempt ID", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
    });
    for (const attemptId of ["first", "second"]) {
      recorder.logSink.log({
        level: "info",
        event: "pi start",
        fields: {
          attemptId,
          agent: "reviewer",
          provider: "test",
          model: "same-model",
          attemptType: "initial",
          attemptNumber: 1,
        },
      });
    }
    recorder.logSink.log({
      level: "info",
      event: "pi run",
      fields: { attemptId: "second", exitCode: 0, durationMs: 20 },
    });
    recorder.logSink.log({
      level: "info",
      event: "pi run",
      fields: { attemptId: "first", exitCode: 1, durationMs: 100 },
    });
    await recorder.finish({ kind: "review", outcome: "failed" });

    const spans = (await readFile(path.join(recorder.directory, "spans.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      spans
        .filter((span) => span.name === "gen_ai.chat")
        .map((span) => ({
          attemptId: span.attributes["pipr.attempt.id"],
          durationMs: span.durationMs,
          status: span.status,
        })),
    ).toEqual([
      { attemptId: "second", durationMs: 20, status: "ok" },
      { attemptId: "first", durationMs: 100, status: "error" },
    ]);
  });

  it("redacts secrets registered after recorder creation", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
    });
    const secret = "runtime-discovered-private-value";
    recorder.observer.registerSecret?.(secret);
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      provider: "test",
      model: "test",
      prompt: `prompt ${secret}`,
    });
    await attempt.finish({ output: `output ${secret}`, stderr: `stderr ${secret}` });
    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const files = await Promise.all(
      [
        "run.json",
        "spans.jsonl",
        "logs.jsonl",
        "metrics.json",
        "artifacts/prompt-001-initial.md",
        "artifacts/output-001-initial.txt",
        "artifacts/stderr-001-initial.txt",
      ].map((file) => readFile(path.join(recorder.directory, file), "utf8")),
    );
    expect(files.join("\n")).not.toContain(secret);
  });

  it("exports content-free traces, metrics, and logs through OTLP HTTP/protobuf", async () => {
    const requests: Array<{ path: string; contentType: string | null; body: Buffer }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          contentType: request.headers.get("content-type"),
          body: Buffer.from(await request.arrayBuffer()),
        });
        return new Response(null, { status: 200 });
      },
    });

    try {
      const rootDirectory = await temporaryDirectory();
      const secret = "run-recorder-test-secret";
      const recorder = await startFileRunRecorder({
        rootDirectory,
        env: {
          OPENAI_API_KEY: secret,
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`,
        },
      });
      recorder.logSink.log({
        level: "info",
        event: "workspace start",
        fields: { repository: "owner/repository", secret },
        text: `preparing ${secret}`,
      });
      const attempt = await recorder.observer.beginAgentAttempt({
        attemptType: "initial",
        attemptNumber: 1,
        agent: "reviewer",
        provider: "openai",
        model: "gpt-test",
        prompt: `review source containing ${secret}`,
      });
      attempt.event({ kind: "first-response" });
      await attempt.finish({ output: `visible output containing ${secret}`, exitCode: 0 });
      recorder.logSink.log({
        level: "info",
        event: "workspace ok",
        fields: { durationMs: 2 },
      });

      await recorder.finish({ kind: "review", outcome: "succeeded" });

      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
      );
      expect(manifest.export.otlp).toBe("succeeded");
      expect(requests.map((request) => request.path).sort()).toEqual([
        "/v1/logs",
        "/v1/metrics",
        "/v1/traces",
      ]);
      expect(requests.every((request) => request.contentType === "application/x-protobuf")).toBe(
        true,
      );
      const exported = Buffer.concat(requests.map((request) => request.body)).toString("utf8");
      expect(exported).not.toContain(secret);
      expect(exported).not.toContain("visible output");
      expect(exported).not.toContain("review source");
      expect(exported).toContain("pipr.run");
      const metricExport = requests.find((request) => request.path === "/v1/metrics");
      expect(metricExport?.body.toString("utf8")).not.toContain(recorder.executionId);
      expect(metricExport?.body.toString("utf8")).not.toContain("owner/repository");
    } finally {
      server.stop(true);
    }
  });

  it("keeps local capture complete when trace sampling is disabled", async () => {
    const paths: string[] = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        paths.push(new URL(request.url).pathname);
        return new Response(null, { status: 200 });
      },
    });

    try {
      const recorder = await startFileRunRecorder({
        rootDirectory: await temporaryDirectory(),
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}`,
          OTEL_TRACES_SAMPLER: "always_off",
        },
      });
      recorder.logSink.log({ level: "info", event: "parse event start", fields: {} });
      recorder.logSink.log({
        level: "info",
        event: "parse event ok",
        fields: { durationMs: 1 },
      });

      await recorder.finish({ kind: "review", outcome: "succeeded" });

      expect(paths).not.toContain("/v1/traces");
      expect(await readFile(path.join(recorder.directory, "spans.jsonl"), "utf8")).toContain(
        "pipr.event.parse",
      );
    } finally {
      server.stop(true);
    }
  });

  it("caps finalization and OTLP flush at two seconds without failing the run", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        return new Response(null, { status: 200 });
      },
    });

    try {
      const recorder = await startFileRunRecorder({
        rootDirectory: await temporaryDirectory(),
        env: { OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${server.port}` },
      });
      const startedAt = performance.now();

      await recorder.finish({ kind: "review", outcome: "succeeded" });

      expect(performance.now() - startedAt).toBeLessThan(2_500);
      const manifest = parseRunBundleManifest(
        JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
      );
      const currentMaxRss = process.resourceUsage().maxRSS;
      const currentMaxRssBytes =
        process.platform === "darwin" ? currentMaxRss : currentMaxRss * 1024;
      expect(manifest.resources.peakRssBytes).toBeGreaterThan(0);
      expect(manifest.resources.peakRssBytes).toBeLessThanOrEqual(currentMaxRssBytes);
      expect(manifest.capture.finalizationTimedOut).toBe(true);
      expect(manifest.export.otlp).toBe("timed-out");
    } finally {
      server.stop(true);
    }
  }, 15_000);

  it("evicts earlier attempt bodies before final-attempt and validation evidence", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
      maxBytes: 8 * 1_024,
    });
    await recorder.addArtifact({
      kind: "output",
      name: "output-001-initial.txt",
      mediaType: "text/plain",
      content: "A".repeat(4_000),
      sensitive: true,
    });
    await recorder.addArtifact({
      kind: "output",
      name: "output-002-repair.txt",
      mediaType: "text/plain",
      content: "B".repeat(4_000),
      sensitive: true,
    });
    await recorder.addArtifact({
      kind: "validation",
      name: "validation.json",
      mediaType: "application/json",
      content: JSON.stringify({ accepted: 1 }),
      sensitive: true,
    });

    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const manifest = parseRunBundleManifest(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
    );
    const firstAttempt = manifest.artifacts.find((artifact) =>
      artifact.path.includes("output-001"),
    );
    const finalAttempt = manifest.artifacts.find((artifact) =>
      artifact.path.includes("output-002"),
    );
    expect(firstAttempt?.omitted).toBe(true);
    expect(firstAttempt?.originalSha256).toHaveLength(64);
    expect(finalAttempt?.omitted).not.toBe(true);
    expect(manifest.artifacts.find((artifact) => artifact.kind === "validation")?.omitted).not.toBe(
      true,
    );
    expect(manifest.capture.truncated).toBe(true);
    expect(
      await readFile(path.join(recorder.directory, finalAttempt?.path ?? "missing"), "utf8"),
    ).toContain("B");
    expect((await loadValidatedRunBundle(recorder.directory)).manifest.executionId).toBe(
      recorder.executionId,
    );
  });

  it("writes and validates empty agent output artifacts", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
    });
    const attempt = await recorder.observer.beginAgentAttempt({
      agent: "reviewer",
      provider: "test",
      model: "test-model",
      attemptType: "initial",
      attemptNumber: 1,
      prompt: "Review this change.",
    });
    await attempt.finish({ exitCode: 1, error: "model failed" });
    await recorder.finish({ kind: "review", outcome: "failed" });

    const bundle = await loadValidatedRunBundle(recorder.directory);
    const output = bundle.manifest.artifacts.find((artifact) => artifact.kind === "output");
    expect(output).toMatchObject({ sizeBytes: 0 });
    expect(output?.omitted).toBeUndefined();
    expect(await readFile(path.join(recorder.directory, output?.path ?? "missing"), "utf8")).toBe(
      "",
    );
  });

  it("clears the active marker when finalization fails", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
    });
    await mkdir(path.join(recorder.directory, "run.json.tmp"));

    await expect(recorder.finish({ kind: "review", outcome: "failed" })).rejects.toThrow();
    await expect(access(path.join(recorder.directory, "active.json"))).rejects.toThrow();
  });

  it("bounds signal streams while preserving the root span and truncation status", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
      maxBytes: 16 * 1024,
    });
    for (let index = 0; index < 200; index += 1) {
      recorder.logSink.log({
        level: "info",
        event: "bounded log",
        fields: { index },
        text: "x".repeat(200),
      });
    }

    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const manifest = parseRunBundleManifest(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
    );
    expect(manifest.capture.truncated).toBe(true);
    expect(await readFile(path.join(recorder.directory, "spans.jsonl"), "utf8")).toContain(
      '"name":"pipr.run"',
    );
    expect((await readFile(path.join(recorder.directory, "logs.jsonl"))).byteLength).toBeLessThan(
      8 * 1024,
    );
  });

  it("keeps timings but omits diagnostic bodies in metadata mode", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
      mode: "metadata",
    });
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      provider: "openai",
      model: "gpt-test",
      prompt: "private prompt",
    });
    await attempt.finish({ output: "private output", exitCode: 0 });

    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const manifest = parseRunBundleManifest(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
    );
    expect(manifest.capture.mode).toBe("metadata");
    expect(manifest.artifacts).toEqual([]);
    const bundleText = await readFile(path.join(recorder.directory, "spans.jsonl"), "utf8");
    expect(bundleText).toContain("attempt_resources");
    expect(bundleText).not.toContain("private prompt");
    expect(bundleText).not.toContain("private output");
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-run-recorder-"));
  temporaryDirectories.push(directory);
  return directory;
}
