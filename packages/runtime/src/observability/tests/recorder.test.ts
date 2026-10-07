import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseRunBundleManifest } from "@usepipr/sdk";
import { loadValidatedRunBundle } from "../archive.js";
import { startFileRunRecorder } from "../file-run-recorder.js";

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

  it("records agent, model, and task spans from harness events without model logs", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
    });
    const task = recorder.observer.beginTask?.({ name: "review", order: 0 });
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      task: "review",
      provider: "openai",
      model: "gpt-test",
      authMode: "subscription",
      shardIndex: 2,
      shardCount: 2,
      conversation: { kind: "fork", parentKey: "a".repeat(64) },
      prompt: "prompt",
    });
    attempt.event({ kind: "turn-start" });
    attempt.event({
      kind: "turn-end",
      model: "gpt-test-2026",
      stopReason: "toolUse",
      usage: turnUsage(10, 2),
      entryKinds: ["pi.system", "pi.assistant", "pi.tool-result"],
    });
    attempt.event({ kind: "turn-start" });
    attempt.event({
      kind: "turn-end",
      model: "gpt-test-2026",
      stopReason: "stop",
      usage: turnUsage(20, 3),
      entryKinds: ["pi.assistant"],
    });
    attempt.event({
      kind: "conversation",
      conversationId: 7,
      entries: conversationEntries("visible answer"),
      truncated: false,
    });
    await attempt.finish({
      output: "visible answer",
      exitCode: 0,
      durationMs: 10,
      usage: {
        status: "complete",
        inputTokens: 30,
        outputTokens: 5,
        cacheReadTokens: 90,
        cacheWriteTokens: 9,
        cacheUsageStatus: "complete",
        costUsd: 0.5,
      },
    });
    task?.finish({ status: "ok", findings: 2, repairAttempted: false });
    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const { spans, manifest } = await loadValidatedRunBundle(recorder.directory);
    expect(spans.filter((span) => span.name === "gen_ai.invoke_agent")).toEqual([
      expect.objectContaining({
        category: "agent",
        status: "ok",
        attributes: expect.objectContaining({
          "gen_ai.agent.name": "reviewer",
          "gen_ai.request.model": "gpt-test",
          "pipr.attempt.id": "001-initial",
          "pipr.task.name": "review",
          "pipr.auth.mode": "subscription",
          "pipr.shard.index": 2,
          "pipr.shard.count": 2,
          "gen_ai.usage.input_tokens": 30,
          "pipr.usage.cache_read_tokens": 90,
          "pipr.usage.cache_status": "complete",
          "pipr.conversation.id": 7,
          "pipr.turn.count": 2,
        }),
      }),
    ]);
    expect(
      spans
        .filter((span) => span.name === "gen_ai.chat")
        .map((span) => ({
          category: span.category,
          model: span.attributes["gen_ai.response.model"],
          stopReason: span.attributes["pipr.turn.stop_reason"],
          input: span.attributes["gen_ai.usage.input_tokens"],
          turn: span.attributes["pipr.turn.index"],
        })),
    ).toEqual([
      { category: "model", model: "gpt-test-2026", stopReason: "toolUse", input: 10, turn: 1 },
      { category: "model", model: "gpt-test-2026", stopReason: "stop", input: 20, turn: 2 },
    ]);
    expect(spans.find((span) => span.name === "pipr.task")).toMatchObject({
      status: "ok",
      attributes: { "pipr.task.name": "review", "pipr.task.order": 0, "pipr.task.findings": 2 },
    });

    const conversation = manifest.artifacts.find((artifact) => artifact.kind === "conversation");
    expect(conversation).toMatchObject({
      path: "artifacts/conversation-001-initial.jsonl",
      sensitive: true,
      counts: {
        entries: 4,
        byKind: { "pi.user": 1, "pi.assistant": 2, "pi.tool-result": 1 },
        tools: { read: 1 },
      },
    });
    const lines = (await readFile(path.join(recorder.directory, conversation?.path ?? ""), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string });
    expect(lines.map((line) => line.kind)).toEqual([
      "pi.user",
      "pi.assistant",
      "pi.tool-result",
      "pi.assistant",
    ]);

    const usage = JSON.parse(
      await readFile(path.join(recorder.directory, "artifacts/usage.json"), "utf8"),
    );
    expect(usage).toMatchObject({
      formatVersion: 1,
      totals: { inputTokens: 30, outputTokens: 5, cacheReadTokens: 90, costUsd: 0.5 },
      byModel: { "gpt-test-2026": { inputTokens: 30, outputTokens: 5, turns: 2 } },
      attempts: [
        {
          attempt: "001-initial",
          agent: "reviewer",
          task: "review",
          model: "gpt-test",
          responseModels: ["gpt-test-2026"],
          turns: 2,
          status: "ok",
          usage: { inputTokens: 30 },
        },
      ],
    });
    const taskGraph = JSON.parse(
      await readFile(path.join(recorder.directory, "artifacts/task-graph.json"), "utf8"),
    );
    expect(taskGraph).toEqual({
      formatVersion: 1,
      tasks: [
        {
          name: "review",
          order: 0,
          status: "ok",
          agents: [
            {
              name: "reviewer",
              attempts: [
                {
                  attempt: "001-initial",
                  attemptType: "initial",
                  provider: "openai",
                  model: "gpt-test",
                  status: "ok",
                  conversationId: 7,
                  conversation: { kind: "fork", parentKey: "a".repeat(64) },
                  shardIndex: 2,
                  shardCount: 2,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(
      manifest.artifacts
        .filter((artifact) => artifact.kind === "usage" || artifact.kind === "task-graph")
        .map((artifact) => artifact.sensitive),
    ).toEqual([false, false]);
  });

  it("never writes a registered or environment secret into the conversation artifact", async () => {
    const environmentKey = "sk-env-provider-key-0123456789";
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: { OPENAI_API_KEY: environmentKey },
    });
    const registered = "registered-runtime-token-value";
    recorder.observer.registerSecret?.(registered);
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      provider: "openai",
      model: "gpt-test",
      prompt: "prompt",
    });
    attempt.event({
      kind: "conversation",
      conversationId: 1,
      entries: conversationEntries(`assistant saw ${registered}`, `tool read ${environmentKey}`),
      truncated: false,
    });
    await attempt.finish({ output: "{}", exitCode: 0 });
    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const { manifest } = await loadValidatedRunBundle(recorder.directory);
    const conversation = manifest.artifacts.find((artifact) => artifact.kind === "conversation");
    const text = await readFile(path.join(recorder.directory, conversation?.path ?? ""), "utf8");
    expect(text).toContain("assistant saw");
    expect(text).not.toContain(registered);
    expect(text).not.toContain(environmentKey);
    expect(await readBundleText(recorder.directory)).not.toContain(registered);
  });

  it("records structural analysis, sharding, budgets, and attributed agent attempts", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {},
    });
    recorder.logSink.log({
      level: "info",
      event: "diff structural analysis",
      fields: {
        status: "available",
        version: "ast-grep 0.40.0",
        durationMs: 25,
        fileCount: 3,
        declarationCount: 12,
      },
    });
    recorder.logSink.log({
      level: "info",
      event: "diff manifest sharded",
      fields: { agent: "reviewer", task: "review", kind: "review", shardCount: 2 },
    });
    recorder.logSink.log({
      level: "info",
      event: "agent run budget",
      fields: { used: 2, limit: 4 },
    });
    recorder.logSink.log({
      level: "info",
      event: "review validated",
      fields: {
        contextFilesTotal: 4,
        contextFilesCovered: 3,
        contextRangesTotal: 10,
        contextRangesCovered: 8,
      },
    });
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      task: "review",
      provider: "openai",
      model: "gpt-test",
      authMode: "subscription",
      shardIndex: 2,
      shardCount: 2,
      prompt: "prompt",
    });
    await attempt.finish({ output: "output", exitCode: 0 });
    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const { spans } = await loadValidatedRunBundle(recorder.directory);
    expect(spans.find((span) => span.name === "pipr.diff.structural_analysis")).toMatchObject({
      durationMs: 25,
      status: "ok",
      attributes: {
        "pipr.structural.status": "available",
        "pipr.structural.version": "ast-grep 0.40.0",
        "pipr.fileCount": 3,
        "pipr.declarationCount": 12,
      },
    });
    expect(spans.find((span) => span.name === "pipr.diff.sharding")).toMatchObject({
      attributes: {
        "pipr.agent.name": "reviewer",
        "pipr.task.name": "review",
        "pipr.shard.count": 2,
      },
    });
    expect(spans.find((span) => span.name === "pipr.agent.run_budget")).toMatchObject({
      attributes: { "pipr.used": 2, "pipr.limit": 4 },
    });
    expect(spans.find((span) => span.name === "pipr.review.validate")).toMatchObject({
      attributes: {
        "pipr.contextFilesTotal": 4,
        "pipr.contextFilesCovered": 3,
        "pipr.contextRangesTotal": 10,
        "pipr.contextRangesCovered": 8,
      },
    });
    for (const spanName of ["gen_ai.invoke_agent", "pipr.agent.attempt_resources"]) {
      expect(spans.find((span) => span.name === spanName)).toMatchObject({
        attributes: {
          "pipr.task.name": "review",
          "pipr.auth.mode": "subscription",
          "pipr.shard.index": 2,
          "pipr.shard.count": 2,
        },
      });
    }
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
    await attempt.finish({ output: `output ${secret}`, error: `stderr ${secret}` });
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

  it("redacts environment secrets from every bundle file", async () => {
    const secrets = {
      GITHUB_TOKEN: "ghs_envSourcedSecretValue123",
      DEEPSEEK_API_KEY: "sk-env-sourced-provider-key-456",
    };
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: secrets,
    });
    const leak = Object.values(secrets).join(" ");
    recorder.logSink.log({ level: "info", event: "context", fields: { leak }, text: leak });
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      provider: "test",
      model: "test",
      prompt: `prompt ${leak}`,
    });
    await attempt.finish({ output: `output ${leak}`, error: `stderr ${leak}` });
    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const bundleText = await readBundleText(recorder.directory);
    expect(bundleText).toContain("artifacts/prompt-001-initial.md");
    for (const secret of Object.values(secrets)) {
      expect(bundleText).not.toContain(secret);
    }
  });

  it("exports content-free traces, metrics, and logs through OTLP HTTP/protobuf", async () => {
    const requests: Array<{
      path: string;
      contentType: string | null;
      authorization: string | null;
      body: Buffer;
    }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          path: new URL(request.url).pathname,
          contentType: request.headers.get("content-type"),
          authorization: request.headers.get("authorization"),
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
          OTEL_EXPORTER_OTLP_HEADERS: " authorization = Bearer%20token ",
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
      expect(requests.every((request) => request.authorization === "Bearer token")).toBe(true);
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

  it("records OTLP header configuration failures in the bundle", async () => {
    const recorder = await startFileRunRecorder({
      rootDirectory: await temporaryDirectory(),
      env: {
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.test",
        OTEL_EXPORTER_OTLP_HEADERS: "authorization=%",
      },
    });

    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const manifest = parseRunBundleManifest(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
    );
    expect(manifest.export.otlp).toBe("failed");
    expect(manifest.capture.errors).toContainEqual(expect.stringContaining("OTLP export failed"));
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
    recorder.logSink.log({
      level: "info",
      event: "pi run",
      fields: { model: "gpt-test", durationMs: 12, path: "private/path.ts" },
      text: "private log",
    });
    recorder.logSink.log({ level: "info", event: "private custom event", fields: {} });
    const attempt = await recorder.observer.beginAgentAttempt({
      attemptType: "initial",
      attemptNumber: 1,
      agent: "reviewer",
      provider: "openai",
      model: "gpt-test",
      prompt: "private prompt",
    });
    await attempt.finish({ output: "private output", error: "private stderr", exitCode: 0 });

    await recorder.finish({ kind: "review", outcome: "succeeded" });

    const manifest = parseRunBundleManifest(
      JSON.parse(await readFile(path.join(recorder.directory, "run.json"), "utf8")),
    );
    expect(manifest.capture.mode).toBe("metadata");
    expect(manifest.artifacts).toEqual([]);
    const spans = await readFile(path.join(recorder.directory, "spans.jsonl"), "utf8");
    expect(spans).toContain("attempt_resources");
    const bundleText = await readBundleText(recorder.directory);
    for (const privateText of [
      "private prompt",
      "private output",
      "private stderr",
      "private log",
      "private/path.ts",
      "private custom event",
    ]) {
      expect(bundleText).not.toContain(privateText);
    }
    const logs = (await readFile(path.join(recorder.directory, "logs.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { event: string; fields: Record<string, unknown> });
    expect(logs.find((log) => log.event === "pi run")?.fields).toEqual({
      model: "gpt-test",
      durationMs: 12,
    });
  });
});

function turnUsage(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
}

/** Harness entries of a short conversation with one `read` tool call. */
function conversationEntries(answer: string, toolOutput = "tool output") {
  return [
    { id: 1, kind: "pi.user", model: [{ role: "user", content: "Review the change." }] },
    {
      id: 2,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }],
        },
      ],
    },
    {
      id: 3,
      kind: "pi.tool-result",
      model: [
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: toolOutput }] },
      ],
    },
    {
      id: 4,
      kind: "pi.assistant",
      model: [{ role: "assistant", content: [{ type: "text", text: answer }] }],
    },
  ];
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-run-recorder-"));
  temporaryDirectories.push(directory);
  return directory;
}

/** Every file of a bundle, each prefixed with its relative path, as one string. */
async function readBundleText(directory: string): Promise<string> {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name))
    .sort();
  const contents = await Promise.all(
    files.map(
      async (file) => `== ${path.relative(directory, file)}\n${await readFile(file, "utf8")}`,
    ),
  );
  return contents.join("\n");
}
