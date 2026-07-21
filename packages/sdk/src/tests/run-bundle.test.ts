import { describe, expect, it } from "bun:test";
import {
  parseRunBundle,
  parseRunBundleManifest,
  type RunBundleManifest,
  type RunLogRecord,
  type RunMetricsSnapshot,
  type RunSpanRecord,
  runBundleArtifactSchema,
  runBundleManifestSchema,
  runLogRecordSchema,
  runMetricsSnapshotSchema,
  runSpanRecordSchema,
} from "../index.js";

describe("Run Bundle manifest", () => {
  it("accepts a complete version 1 diagnostic manifest", () => {
    const manifest = {
      formatVersion: 1,
      executionId: "0123456789abcdef0123456789abcdef",
      workId: "pipr-review-work",
      kind: "review",
      outcome: "succeeded",
      startedAt: "2026-07-20T10:00:00.000Z",
      endedAt: "2026-07-20T10:00:05.000Z",
      durationMs: 5000,
      repository: {
        host: "github",
        repository: "somus/pipr",
        changeNumber: 42,
        changeUrl: "https://github.com/somus/pipr/pull/42",
        baseSha: "base-sha",
        headSha: "head-sha",
      },
      provider: {
        runId: "100",
        jobId: "200",
        runUrl: "https://github.com/somus/pipr/actions/runs/100",
      },
      pipr: { version: "0.4.3", configHash: "a".repeat(64) },
      capture: {
        mode: "diagnostic",
        completeness: "complete",
        redactionApplied: true,
        truncated: false,
        limitBytes: 67_108_864,
        finalizationTimedOut: false,
        errors: [],
      },
      export: { otlp: "disabled", externalUpload: "pending" },
      resources: {
        cpuUserMs: 120,
        cpuSystemMs: 30,
        peakRssBytes: 100_000_000,
        runtime: "bun 1.3.14",
        runner: "github-actions",
      },
      signals: {
        spans: "spans.jsonl",
        logs: "logs.jsonl",
        metrics: "metrics.json",
      },
      artifacts: [
        {
          kind: "prompt",
          path: "artifacts/prompt-final.md",
          mediaType: "text/markdown",
          sizeBytes: 12,
          sha256: "b".repeat(64),
          sensitive: true,
          truncated: false,
        },
      ],
    } satisfies RunBundleManifest;

    expect(parseRunBundleManifest(manifest)).toEqual(manifest);
    expect(parseRunBundle(manifest)).toEqual(manifest);
  });

  it("rejects unknown fields and paths outside the bundle", () => {
    const base = {
      formatVersion: 1,
      executionId: "0123456789abcdef0123456789abcdef",
      kind: "startup",
      outcome: "failed",
      startedAt: "2026-07-20T10:00:00.000Z",
      pipr: { version: "0.4.3" },
      capture: {
        mode: "metadata",
        completeness: "partial",
        redactionApplied: true,
        truncated: false,
        limitBytes: 67_108_864,
        finalizationTimedOut: false,
        errors: ["event parsing failed"],
      },
      export: { otlp: "disabled", externalUpload: "not-configured" },
      resources: { runtime: "bun 1.3.14" },
      signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
      artifacts: [],
    };

    expect(runBundleManifestSchema.safeParse({ ...base, privateField: true }).success).toBe(false);
    expect(
      runBundleManifestSchema.safeParse({
        ...base,
        artifacts: [
          {
            kind: "stderr",
            path: "../secret.txt",
            mediaType: "text/plain",
            sizeBytes: 1,
            sha256: "c".repeat(64),
            sensitive: true,
            truncated: false,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("Run Bundle signals", () => {
  it("validates content-free spans, correlated logs, and low-cardinality metrics", () => {
    const span = {
      formatVersion: 1,
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "0123456789abcdef",
      name: "pipr.diff.build",
      category: "phase",
      startedAt: "2026-07-20T10:00:00.000Z",
      endedAt: "2026-07-20T10:00:01.000Z",
      durationMs: 1000,
      status: "ok",
      attributes: { "pipr.diff.files": 4, "pipr.diff.condensed": false },
    } satisfies RunSpanRecord;
    const log = {
      formatVersion: 1,
      timestamp: "2026-07-20T10:00:00.500Z",
      sequence: 1,
      level: "notice",
      event: "diff built",
      traceId: span.traceId,
      spanId: span.spanId,
      fields: { files: 4 },
      text: "| redacted diagnostic text",
    } satisfies RunLogRecord;
    const metrics = {
      formatVersion: 1,
      counters: [
        {
          name: "pipr.run.count",
          value: 1,
          attributes: { host: "github", runKind: "review", outcome: "succeeded" },
        },
      ],
      histograms: [
        {
          name: "pipr.run.duration",
          count: 1,
          sum: 1000,
          min: 1000,
          max: 1000,
          attributes: { host: "github", runKind: "review" },
        },
      ],
    } satisfies RunMetricsSnapshot;

    expect(runSpanRecordSchema.parse(span)).toEqual(span);
    expect(runLogRecordSchema.parse(log)).toEqual(log);
    expect(runMetricsSnapshotSchema.parse(metrics)).toEqual(metrics);
  });

  it("rejects sensitive span fields and high-cardinality metric labels", () => {
    expect(
      runSpanRecordSchema.safeParse({
        formatVersion: 1,
        traceId: "0123456789abcdef0123456789abcdef",
        spanId: "0123456789abcdef",
        name: "gen_ai.chat",
        category: "model",
        startedAt: "2026-07-20T10:00:00.000Z",
        status: "error",
        attributes: { prompt: "private source" },
      }).success,
    ).toBe(false);
    expect(
      runMetricsSnapshotSchema.safeParse({
        formatVersion: 1,
        counters: [
          {
            name: "pipr.run.count",
            value: 1,
            attributes: { repository: "somus/pipr" },
          },
        ],
        histograms: [],
      }).success,
    ).toBe(false);
  });
});

describe("Run Bundle artifact truncation", () => {
  it("records the original size and hash when an artifact is truncated or omitted", () => {
    const truncated = {
      kind: "output" as const,
      path: "artifacts/output-001-initial.txt",
      mediaType: "text/plain",
      sizeBytes: 1024,
      sha256: "a".repeat(64),
      sensitive: true,
      truncated: true,
      originalSizeBytes: 4096,
      originalSha256: "b".repeat(64),
      omitted: false,
    };
    const omitted = {
      ...truncated,
      sizeBytes: 0,
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      omitted: true,
    };

    expect(runBundleArtifactSchema.parse(truncated)).toEqual(truncated);
    expect(runBundleArtifactSchema.parse(omitted)).toEqual(omitted);
    expect(
      runBundleArtifactSchema.safeParse({
        ...truncated,
        originalSizeBytes: undefined,
        originalSha256: undefined,
      }).success,
    ).toBe(false);
    expect(runBundleArtifactSchema.safeParse({ ...omitted, truncated: false }).success).toBe(false);
  });
});
