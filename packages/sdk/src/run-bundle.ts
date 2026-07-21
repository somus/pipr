import { z } from "zod";

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const duration = z.number().nonnegative().finite();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bundlePath = text
  .max(1024)
  .refine(
    (value) =>
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "path must stay inside the run bundle",
  );

export const runBundleArtifactSchema = z
  .strictObject({
    kind: z.enum([
      "prompt",
      "output",
      "stderr",
      "diff-manifest",
      "validation",
      "publication-plan",
      "other",
    ]),
    path: bundlePath,
    mediaType: text.max(200),
    sizeBytes: count,
    sha256,
    sensitive: z.boolean(),
    truncated: z.boolean(),
    originalSizeBytes: count.optional(),
    originalSha256: sha256.optional(),
    omitted: z.boolean().optional(),
  })
  .superRefine((artifact, context) => {
    validateTruncationMetadata(artifact, context);
    validateOmittedArtifact(artifact, context);
  });

export type RunBundleArtifact = z.infer<typeof runBundleArtifactSchema>;

type ArtifactInput = z.infer<typeof runBundleArtifactSchema>;

function validateTruncationMetadata(artifact: ArtifactInput, context: z.RefinementCtx): void {
  if (artifact.truncated) {
    if (hasValidOriginalArtifact(artifact)) return;
    context.addIssue({
      code: "custom",
      message: "truncated artifacts require a larger original size and original hash",
    });
    return;
  }
  if (hasTruncationMetadata(artifact)) {
    context.addIssue({
      code: "custom",
      message: "complete artifacts cannot contain truncation metadata",
    });
  }
}

function hasValidOriginalArtifact(artifact: ArtifactInput): boolean {
  return (
    artifact.originalSizeBytes !== undefined &&
    artifact.originalSha256 !== undefined &&
    artifact.originalSizeBytes > artifact.sizeBytes
  );
}

function hasTruncationMetadata(artifact: ArtifactInput): boolean {
  return (
    artifact.originalSizeBytes !== undefined ||
    artifact.originalSha256 !== undefined ||
    artifact.omitted === true
  );
}

function validateOmittedArtifact(artifact: ArtifactInput, context: z.RefinementCtx): void {
  if (!artifact.omitted || artifact.sizeBytes === 0) return;
  context.addIssue({ code: "custom", message: "omitted artifacts must have zero stored bytes" });
}

const attributeScalar = z.union([z.string().max(2000), z.number().finite(), z.boolean()]);
const attributeValue = z.union([attributeScalar, z.array(attributeScalar).max(100)]);
const sensitiveSpanAttribute =
  /prompt|output|content|body|stderr|environment|secret|reasoning|tool[._-]?(input|output)/i;
const contentMetadataSuffix =
  /(?:bytes|size|hash|count|status|duration|tokens|cost|id|name|model)$/i;
const spanAttributes = z
  .record(z.string().min(1).max(200), attributeValue)
  .refine(
    (attributes) =>
      Object.keys(attributes).every(
        (key) => !sensitiveSpanAttribute.test(key) || contentMetadataSuffix.test(key),
      ),
    "span attributes must not contain diagnostic content",
  );

export const runSpanRecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  spanId: z.string().regex(/^[a-f0-9]{16}$/),
  parentSpanId: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  name: text.max(500),
  category: z.enum(["run", "phase", "agent", "model", "tool", "http", "internal"]),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: duration.optional(),
  status: z.enum(["unset", "ok", "error"]),
  attributes: spanAttributes,
});

export type RunSpanRecord = z.infer<typeof runSpanRecordSchema>;

export const runLogRecordSchema = z.strictObject({
  formatVersion: z.literal(1),
  timestamp: z.string().datetime({ offset: true }),
  sequence: count,
  level: z.enum(["info", "notice", "warning", "error", "debug"]),
  event: text.max(500),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  spanId: z
    .string()
    .regex(/^[a-f0-9]{16}$/)
    .optional(),
  fields: z.record(z.string().min(1).max(200), attributeValue),
  text: z.string().max(65_536).optional(),
});

export type RunLogRecord = z.infer<typeof runLogRecordSchema>;

const metricAttributes = z.strictObject({
  host: z.enum(["github", "gitlab", "azure-devops", "bitbucket", "local"]).optional(),
  runKind: z.enum(["review", "command", "verifier", "startup"]).optional(),
  outcome: z.enum(["in-progress", "succeeded", "failed", "partial"]).optional(),
  failureCategory: z
    .enum([
      "startup",
      "event",
      "auth",
      "workspace",
      "trusted-config",
      "diff",
      "dispatch",
      "agent-timeout",
      "agent-exit",
      "invalid-output",
      "validation",
      "publication",
      "stale-head",
      "capture",
      "unknown",
    ])
    .optional(),
  attemptType: z.enum(["initial", "retry", "repair", "fallback"]).optional(),
  providerFamily: text.max(100).optional(),
});

const metricCounter = z.strictObject({
  name: text.max(200),
  value: z.number().nonnegative().finite(),
  attributes: metricAttributes,
});

const metricHistogram = z.strictObject({
  name: text.max(200),
  count,
  sum: z.number().nonnegative().finite(),
  min: z.number().nonnegative().finite(),
  max: z.number().nonnegative().finite(),
  attributes: metricAttributes,
});

export const runMetricsSnapshotSchema = z.strictObject({
  formatVersion: z.literal(1),
  counters: z.array(metricCounter).max(1000),
  histograms: z.array(metricHistogram).max(1000),
});

export type RunMetricsSnapshot = z.infer<typeof runMetricsSnapshotSchema>;

const repositorySchema = z.strictObject({
  host: z.enum(["github", "gitlab", "azure-devops", "bitbucket", "local"]),
  repository: text.max(500),
  changeNumber: z.number().int().positive().optional(),
  changeUrl: z.string().url().max(2000).optional(),
  baseSha: text.max(200).optional(),
  headSha: text.max(200).optional(),
});

const providerRunSchema = z.strictObject({
  runId: text.max(500).optional(),
  jobId: text.max(500).optional(),
  runUrl: z.string().url().max(2000).optional(),
  jobUrl: z.string().url().max(2000).optional(),
});

const captureSchema = z.strictObject({
  mode: z.enum(["off", "metadata", "diagnostic"]),
  completeness: z.enum(["complete", "partial"]),
  redactionApplied: z.boolean(),
  truncated: z.boolean(),
  limitBytes: count,
  finalizationTimedOut: z.boolean(),
  errors: z.array(text.max(1000)).max(100),
});

const exportSchema = z.strictObject({
  otlp: z.enum(["disabled", "succeeded", "failed", "timed-out"]),
  externalUpload: z.enum(["not-configured", "pending", "available", "failed"]),
});

const resourcesSchema = z.strictObject({
  cpuUserMs: duration.optional(),
  cpuSystemMs: duration.optional(),
  peakRssBytes: count.optional(),
  runtime: text.max(200),
  runner: text.max(200).optional(),
});

const signalsSchema = z.strictObject({
  spans: bundlePath,
  logs: bundlePath,
  metrics: bundlePath,
});

export const runBundleManifestSchema = z.strictObject({
  formatVersion: z.literal(1),
  executionId: z.string().regex(/^[a-f0-9]{32}$/),
  workId: text.max(200).optional(),
  kind: z.enum(["review", "command", "verifier", "startup"]),
  outcome: z.enum(["in-progress", "succeeded", "failed", "partial"]),
  failureCategory: z
    .enum([
      "startup",
      "event",
      "auth",
      "workspace",
      "trusted-config",
      "diff",
      "dispatch",
      "agent-timeout",
      "agent-exit",
      "invalid-output",
      "validation",
      "publication",
      "stale-head",
      "capture",
      "unknown",
    ])
    .optional(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional(),
  durationMs: duration.optional(),
  repository: repositorySchema.optional(),
  provider: providerRunSchema.optional(),
  pipr: z.strictObject({
    version: text.max(100),
    configVersion: text.max(100).optional(),
    configHash: sha256.optional(),
  }),
  capture: captureSchema,
  export: exportSchema,
  resources: resourcesSchema,
  signals: signalsSchema,
  artifacts: z.array(runBundleArtifactSchema).max(10_000),
});

export type RunBundleManifest = z.infer<typeof runBundleManifestSchema>;
export const runBundleSchema = runBundleManifestSchema;
export type RunBundle = RunBundleManifest;

export function parseRunBundleManifest(value: unknown): RunBundleManifest {
  return runBundleManifestSchema.parse(value);
}

export function parseRunBundle(value: unknown): RunBundle {
  return runBundleSchema.parse(value);
}
