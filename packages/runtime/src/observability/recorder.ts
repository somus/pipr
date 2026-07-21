import { createHash, randomBytes } from "node:crypto";
import {
  appendFile,
  chmod,
  chown,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";
import type {
  RunBundleArtifact,
  RunBundleManifest,
  RunLogRecord,
  RunMetricsSnapshot,
  RunSpanRecord,
} from "@usepipr/sdk";
import type { RuntimeLogRecord, RuntimeLogSink } from "../shared/logging.js";
import { createKnownSecretRedactor } from "../shared/secret-redactor.js";
import { runtimeVersion } from "../shared/version.js";
import { exportRunTelemetry } from "./otlp.js";
import { activeCaptureHeartbeatMilliseconds, currentProcessIdentity } from "./retention-store.js";
import { maximumRunBundleBytes, type RunAgentEvent, type RunObserver } from "./types.js";

const emptySha256 = createHash("sha256").update("").digest("hex");

export type RunFailureCategory = NonNullable<RunBundleManifest["failureCategory"]>;

export type RunRecorderFinish = {
  kind: RunBundleManifest["kind"];
  outcome: RunBundleManifest["outcome"];
  failureCategory?: RunFailureCategory;
  workId?: string;
  repository?: RunBundleManifest["repository"];
  provider?: RunBundleManifest["provider"];
  configVersion?: string;
  configHash?: string;
};

export type RunRecorder = {
  executionId: string;
  directory: string;
  logSink: RuntimeLogSink;
  observer: RunObserver;
  addArtifact(artifact: {
    kind: RunBundleArtifact["kind"];
    name: string;
    mediaType: string;
    content: string;
    sensitive: boolean;
  }): Promise<void>;
  discard(): Promise<void>;
  finish(result: RunRecorderFinish): Promise<void>;
};

export type InMemoryRunCapture = {
  logs: RuntimeLogRecord[];
  groups: string[];
  artifacts: Array<Parameters<RunRecorder["addArtifact"]>[0]>;
  attempts: Array<{
    options: Parameters<RunObserver["beginAgentAttempt"]>[0];
    events: RunAgentEvent[];
    result?: Parameters<Awaited<ReturnType<RunObserver["beginAgentAttempt"]>>["finish"]>[0];
  }>;
  result?: RunRecorderFinish;
  discarded: boolean;
};

export function createNoopRunRecorder(): RunRecorder {
  return {
    executionId: randomBytes(16).toString("hex"),
    directory: "",
    logSink: {
      log() {},
      async group(_name, run) {
        return await run();
      },
    },
    observer: {
      async recordArtifact() {},
      async beginAgentAttempt() {
        return { event() {}, async finish() {} };
      },
    },
    async addArtifact() {},
    async discard() {},
    async finish() {},
  };
}

export function createInMemoryRunRecorder(options: { executionId?: string } = {}): RunRecorder & {
  capture: InMemoryRunCapture;
} {
  const capture: InMemoryRunCapture = {
    logs: [],
    groups: [],
    artifacts: [],
    attempts: [],
    discarded: false,
  };
  return {
    executionId: options.executionId ?? randomBytes(16).toString("hex"),
    directory: "memory://pipr-run",
    capture,
    logSink: {
      log(record) {
        capture.logs.push(record);
      },
      async group(name, run) {
        capture.groups.push(name);
        return await run();
      },
    },
    observer: {
      async recordArtifact(artifact) {
        capture.artifacts.push(artifact);
      },
      async beginAgentAttempt(attemptOptions) {
        const attempt: InMemoryRunCapture["attempts"][number] = {
          options: attemptOptions,
          events: [],
        };
        capture.attempts.push(attempt);
        return {
          event(event) {
            attempt.events.push(event);
          },
          async finish(result) {
            attempt.result = result;
          },
        };
      },
    },
    async addArtifact(artifact) {
      capture.artifacts.push(artifact);
    },
    async discard() {
      capture.discarded = true;
    },
    async finish(result) {
      capture.result = result;
    },
  };
}

export async function startFileRunRecorder(options: {
  rootDirectory: string;
  env?: NodeJS.ProcessEnv;
  mode?: RunBundleManifest["capture"]["mode"];
  externalUpload?: RunBundleManifest["export"]["externalUpload"];
  maxBytes?: number;
}): Promise<RunRecorder> {
  const rootDirectory = path.resolve(options.rootDirectory);
  const owner = await nearestDirectoryOwner(rootDirectory);
  await ensureSafeDirectory(rootDirectory);
  const executionId = randomBytes(16).toString("hex");
  const directory = path.join(rootDirectory, executionId);
  await mkdir(directory, { mode: 0o700 });
  await chmod(directory, 0o700);

  const spansPath = path.join(directory, "spans.jsonl");
  const logsPath = path.join(directory, "logs.jsonl");
  const metricsPath = path.join(directory, "metrics.json");
  await Promise.all([
    writePrivateFile(spansPath, ""),
    writePrivateFile(logsPath, ""),
    writePrivateFile(metricsPath, `${JSON.stringify(emptyMetrics())}\n`),
  ]);

  const startedAt = new Date();
  const activePath = path.join(directory, "active.json");
  await writePrivateFile(
    activePath,
    `${JSON.stringify({
      executionId,
      startedAt: startedAt.toISOString(),
      heartbeatAt: startedAt.toISOString(),
      pid: process.pid,
      processIdentity: currentProcessIdentity,
    })}\n`,
  );
  const startedMs = Date.now();
  const startedCpu = process.resourceUsage();
  const rootSpanId = randomBytes(8).toString("hex");
  const captureErrors: string[] = [];
  const artifacts: RunBundleArtifact[] = [];
  const artifactPriorities = new Map<RunBundleArtifact, number>();
  const spanRecords: RunSpanRecord[] = [];
  const logRecords: RunLogRecord[] = [];
  const redactor = createKnownSecretRedactor({ env: options.env });
  const openSpans = new Map<string, OpenSpan[]>();
  let artifactBytes = 0;
  const bundleLimitBytes = options.maxBytes ?? maximumRunBundleBytes;
  const signalReserveBytes = Math.min(
    12 * 1024 * 1024,
    Math.max(256, Math.floor(bundleLimitBytes / 4)),
  );
  const artifactLimitBytes = Math.max(0, bundleLimitBytes - signalReserveBytes);
  const spanLimitBytes = Math.floor(signalReserveBytes / 3);
  const logLimitBytes = Math.floor(signalReserveBytes / 3);
  let spanBytes = 0;
  let logBytes = 0;
  let signalTruncated = false;
  let agentAttemptSequence = 0;
  let groupSequence = 0;
  let sequence = 0;
  let finished = false;
  let pendingWrites = Promise.resolve();
  let heartbeatWrite = Promise.resolve();
  const heartbeatTimer = setInterval(() => {
    heartbeatWrite = heartbeatWrite
      .then(() =>
        writePrivateFile(
          activePath,
          `${JSON.stringify({
            executionId,
            startedAt: startedAt.toISOString(),
            heartbeatAt: new Date().toISOString(),
            pid: process.pid,
            processIdentity: currentProcessIdentity,
          })}\n`,
        ),
      )
      .catch((error: unknown) => {
        captureErrors.push(safeErrorMessage(error));
      });
  }, activeCaptureHeartbeatMilliseconds);
  heartbeatTimer.unref();

  const stopHeartbeat = async (): Promise<void> => {
    clearInterval(heartbeatTimer);
    await heartbeatWrite;
  };

  const queueSpan = (span: RunSpanRecord) => {
    const line = `${JSON.stringify(span)}\n`;
    const bytes = Buffer.byteLength(line);
    if (spanBytes + bytes > spanLimitBytes) {
      signalTruncated = true;
      return;
    }
    spanBytes += bytes;
    spanRecords.push(span);
    pendingWrites = pendingWrites
      .then(() => appendFile(spansPath, line, { encoding: "utf8" }))
      .catch((error: unknown) => {
        captureErrors.push(safeErrorMessage(error));
      });
  };

  const openSpan = (
    key: string,
    name: string,
    category: RunSpanRecord["category"],
    attributes: RunSpanRecord["attributes"],
  ) => {
    const spans = openSpans.get(key) ?? [];
    spans.push({
      spanId: randomBytes(8).toString("hex"),
      name,
      category,
      attributes,
      startedAt: new Date(),
      startedMs: Date.now(),
    });
    openSpans.set(key, spans);
  };

  const closeSpan = (
    key: string,
    status: RunSpanRecord["status"],
    durationMs?: number,
    attributes: RunSpanRecord["attributes"] = {},
  ) => {
    const spans = openSpans.get(key);
    const span = spans?.shift();
    if (!span) return;
    if (spans?.length === 0) openSpans.delete(key);
    const endedAt = new Date();
    queueSpan({
      formatVersion: 1,
      traceId: executionId,
      spanId: span.spanId,
      parentSpanId: rootSpanId,
      name: span.name,
      category: span.category,
      startedAt: span.startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs: Math.max(0, durationMs ?? Date.now() - span.startedMs),
      status,
      attributes: { ...span.attributes, ...attributes },
    });
  };

  const observeLogRecord = (record: RuntimeLogRecord) => {
    if (observeModelLog(record)) return;
    if (observePhaseLog(record)) return;
    if (observeTaskLog(record)) return;
    observeInstantLog(record);
  };

  const observeModelLog = (record: RuntimeLogRecord): boolean => {
    if (record.event === "pi start") {
      openSpan(modelSpanKey(record), "gen_ai.chat", "model", modelSpanAttributes(record));
      return true;
    }
    if (record.event !== "pi run") return false;
    const exitCode = numberField(record, "exitCode");
    closeSpan(
      modelSpanKey(record),
      exitCode === undefined || exitCode === 0 ? "ok" : "error",
      numberField(record, "durationMs"),
      modelResultAttributes(record),
    );
    return true;
  };

  const observePhaseLog = (record: RuntimeLogRecord): boolean => {
    const phaseStart = phaseNameFromStart(record.event);
    if (phaseStart) {
      openSpan(`phase:${phaseStart}`, phaseSpanName(phaseStart), "phase", {});
      return true;
    }
    const phaseEnd = phaseNameFromEnd(record.event);
    if (!phaseEnd) return false;
    closeSpan(
      `phase:${phaseEnd.name}`,
      phaseEnd.failed ? "error" : "ok",
      numberField(record, "durationMs"),
    );
    return true;
  };

  const observeTaskLog = (record: RuntimeLogRecord): boolean => {
    if (record.event === "task start") {
      openSpan(`task:${stringField(record, "task")}`, "pipr.task", "phase", {
        "pipr.task.name": stringField(record, "task"),
        "pipr.task.order": numberField(record, "order") ?? 0,
      });
      return true;
    }
    if (record.event !== "task ok" && record.event !== "task failed") return false;
    closeSpan(
      `task:${stringField(record, "task")}`,
      record.event === "task failed" ? "error" : "ok",
      numberField(record, "durationMs"),
      {
        "pipr.task.findings": numberField(record, "findings") ?? 0,
        "pipr.task.repair_attempted": booleanField(record, "repairAttempted") ?? false,
      },
    );
    return true;
  };

  const observeInstantLog = (record: RuntimeLogRecord): void => {
    const spanName = instantLogSpanName(record.event);
    if (!spanName) return;
    const now = new Date().toISOString();
    queueSpan({
      formatVersion: 1,
      traceId: executionId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: rootSpanId,
      name: spanName,
      category: "phase",
      startedAt: now,
      endedAt: now,
      durationMs: 0,
      status: "ok",
      attributes: numericLogAttributes(record),
    });
  };

  const queueLog = (record: RuntimeLogRecord) => {
    observeLogRecord(record);
    const bundleRecord: RunLogRecord = {
      formatVersion: 1,
      timestamp: new Date().toISOString(),
      sequence: sequence++,
      level: record.level,
      event: boundLogString(record.event, 500, markSignalTruncated),
      traceId: executionId,
      spanId: rootSpanId,
      fields: normalizeLogFields(record.fields, redactor, markSignalTruncated),
      ...(record.text === undefined
        ? {}
        : {
            text: boundLogString(redactor.redact(record.text).value, 65_536, markSignalTruncated),
          }),
    };
    const line = `${JSON.stringify(bundleRecord)}\n`;
    const bytes = Buffer.byteLength(line);
    if (logBytes + bytes > logLimitBytes) {
      signalTruncated = true;
      return;
    }
    logBytes += bytes;
    logRecords.push(bundleRecord);
    pendingWrites = pendingWrites
      .then(() => appendFile(logsPath, line, { encoding: "utf8" }))
      .catch((error: unknown) => {
        captureErrors.push(safeErrorMessage(error));
      });
  };

  return {
    executionId,
    directory,
    logSink: {
      log: queueLog,
      async group(name, run) {
        const key = `group:${groupSequence++}:${name}`;
        const publication = name.startsWith("publish ");
        openSpan(
          key,
          publication
            ? `pipr.publish.${name.slice("publish ".length).replaceAll(" ", "_")}`
            : `pipr.${name.replaceAll(" ", "_")}`,
          "phase",
          {},
        );
        try {
          const result = await run();
          closeSpan(key, "ok");
          return result;
        } catch (error) {
          closeSpan(key, "error");
          throw error;
        }
      },
    },
    observer: {
      registerSecret(value) {
        redactor.addSecret(value);
      },
      async recordArtifact(artifact) {
        await addRecorderArtifact(artifact);
      },
      async beginAgentAttempt(attempt) {
        agentAttemptSequence += 1;
        const sequence = String(agentAttemptSequence).padStart(3, "0");
        const suffix = `${sequence}-${attempt.attemptType}`;
        const attemptStartedAt = new Date();
        const attemptStartedMs = Date.now();
        const attemptStartedResources = resourceSnapshot();
        let firstResponseRecorded = false;
        await addRecorderArtifact({
          kind: "prompt",
          name: `prompt-${suffix}.md`,
          mediaType: "text/markdown",
          content: attempt.prompt,
          sensitive: true,
        });
        let attemptFinished = false;
        return {
          event(event) {
            observeAttemptEvent(event, {
              suffix,
              attempt,
              attemptStartedAt,
              attemptStartedMs,
              firstResponseRecorded,
              markFirstResponseRecorded() {
                firstResponseRecorded = true;
              },
              openSpan,
              closeSpan,
              queueSpan,
              executionId,
              rootSpanId,
            });
          },
          async finish(result) {
            if (attemptFinished) return;
            attemptFinished = true;
            await finishAgentAttempt({
              suffix,
              attempt,
              attemptStartedAt,
              attemptStartedMs,
              attemptStartedResources,
              result,
            });
          },
        };
      },
    },
    async addArtifact(artifact) {
      await addRecorderArtifact(artifact);
    },
    async discard() {
      if (finished) return;
      finished = true;
      await stopHeartbeat();
      await pendingWrites;
      await rm(directory, { recursive: true, force: true });
    },
    async finish(result) {
      if (finished) return;
      finished = true;
      await stopHeartbeat();
      try {
        await finalizeRun(result);
      } finally {
        await rm(activePath, { force: true });
      }
    },
  };

  function markSignalTruncated(): void {
    signalTruncated = true;
  }

  async function finishAgentAttempt(context: {
    suffix: string;
    attempt: Parameters<RunObserver["beginAgentAttempt"]>[0];
    attemptStartedAt: Date;
    attemptStartedMs: number;
    attemptStartedResources: ReturnType<typeof resourceSnapshot>;
    result: Parameters<Awaited<ReturnType<RunObserver["beginAgentAttempt"]>>["finish"]>[0];
  }): Promise<void> {
    const failed = context.result.error !== undefined || (context.result.exitCode ?? 0) !== 0;
    closeAttemptSpans(context.suffix, failed);
    await addRecorderArtifact({
      kind: "output",
      name: `output-${context.suffix}.txt`,
      mediaType: "text/plain",
      content: context.result.output ?? "",
      sensitive: true,
    });
    await addAttemptStderr(context.suffix, context.result.stderr || context.result.error);
    queueAttemptResources(context, failed, resourceSnapshot());
  }

  function closeAttemptSpans(suffix: string, failed: boolean): void {
    for (const key of [...openSpans.keys()]) {
      if (key.includes(`:${suffix}:`) || key.endsWith(`:${suffix}`)) {
        closeSpan(key, failed ? "error" : "ok");
      }
    }
  }

  async function addAttemptStderr(suffix: string, stderr: string | undefined): Promise<void> {
    if (!stderr) return;
    await addRecorderArtifact({
      kind: "stderr",
      name: `stderr-${suffix}.txt`,
      mediaType: "text/plain",
      content: stderr,
      sensitive: true,
    });
  }

  function queueAttemptResources(
    context: {
      attempt: Parameters<RunObserver["beginAgentAttempt"]>[0];
      attemptStartedAt: Date;
      attemptStartedMs: number;
      attemptStartedResources: ReturnType<typeof resourceSnapshot>;
    },
    failed: boolean,
    ended: ReturnType<typeof resourceSnapshot>,
  ): void {
    queueSpan({
      formatVersion: 1,
      traceId: executionId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: rootSpanId,
      name: "pipr.agent.attempt_resources",
      category: "internal",
      startedAt: context.attemptStartedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - context.attemptStartedMs),
      status: failed ? "error" : "ok",
      attributes: {
        "pipr.attempt.type": context.attempt.attemptType,
        "pipr.resource.cpu_user_ms": Math.max(
          0,
          ended.cpuUserMs - context.attemptStartedResources.cpuUserMs,
        ),
        "pipr.resource.cpu_system_ms": Math.max(
          0,
          ended.cpuSystemMs - context.attemptStartedResources.cpuSystemMs,
        ),
        "pipr.resource.peak_rss_bytes": ended.peakRssBytes,
      },
    });
  }

  async function finalizeRun(result: RunRecorderFinish): Promise<void> {
    const finalizationDeadline = Date.now() + 2_000;
    closeAllOpenSpans();
    await pendingWrites;
    const endedAt = new Date();
    const durationMs = Math.max(0, Date.now() - startedMs);
    await appendRootSpan(createRootSpan(result, endedAt, durationMs));
    const metrics = runMetrics(result, durationMs);
    const metricsContents = `${JSON.stringify(metrics)}\n`;
    await writePrivateFile(metricsPath, metricsContents);
    artifacts.sort((left, right) => left.path.localeCompare(right.path));
    const manifest = createManifest(result, endedAt, durationMs, process.resourceUsage());
    await enforceFinalBundleLimit(manifest, Buffer.byteLength(metricsContents));
    refreshCaptureStatus(manifest);
    await exportAndWriteManifest(manifest, metrics, finalizationDeadline);
    await preserveStoreOwnership(rootDirectory, directory, owner);
  }

  function closeAllOpenSpans(): void {
    for (const [key, spans] of openSpans) {
      while (spans.length > 0) closeSpan(key, "error");
    }
  }

  function createRootSpan(
    result: RunRecorderFinish,
    endedAt: Date,
    durationMs: number,
  ): RunSpanRecord {
    const attributes: RunSpanRecord["attributes"] = {
      "pipr.run.kind": result.kind,
      "pipr.run.outcome": result.outcome,
    };
    setDefined(attributes, "pipr.run.failure_category", result.failureCategory);
    return {
      formatVersion: 1,
      traceId: executionId,
      spanId: rootSpanId,
      name: "pipr.run",
      category: "run",
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      status: result.outcome === "failed" ? "error" : "ok",
      attributes,
    };
  }

  async function appendRootSpan(rootSpan: RunSpanRecord): Promise<void> {
    spanRecords.push(rootSpan);
    const line = `${JSON.stringify(rootSpan)}\n`;
    spanBytes += Buffer.byteLength(line);
    await appendFile(spansPath, line, { encoding: "utf8" });
  }

  function createManifest(
    result: RunRecorderFinish,
    endedAt: Date,
    durationMs: number,
    endedCpu: NodeJS.ResourceUsage,
  ): RunBundleManifest {
    const manifest: RunBundleManifest = {
      formatVersion: 1,
      executionId,
      kind: result.kind,
      outcome: result.outcome,
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationMs,
      pipr: { version: runtimeVersion },
      capture: initialCapture(result),
      export: {
        otlp: "disabled",
        externalUpload: options.externalUpload ?? "not-configured",
      },
      resources: runResources(endedCpu),
      signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
      artifacts,
    };
    setDefined(manifest, "workId", result.workId);
    setDefined(manifest, "failureCategory", result.failureCategory);
    setDefined(manifest, "repository", result.repository);
    setDefined(manifest, "provider", result.provider);
    setDefined(manifest.pipr, "configVersion", result.configVersion);
    setDefined(manifest.pipr, "configHash", result.configHash);
    return manifest;
  }

  function initialCapture(result: RunRecorderFinish): RunBundleManifest["capture"] {
    return {
      mode: options.mode ?? "diagnostic",
      completeness:
        captureErrors.length > 0 || (result.outcome === "failed" && agentAttemptSequence === 0)
          ? "partial"
          : "complete",
      redactionApplied: true,
      truncated: signalTruncated || artifacts.some((artifact) => artifact.truncated),
      limitBytes: bundleLimitBytes,
      finalizationTimedOut: false,
      errors: captureErrors.slice(0, 100),
    };
  }

  function runResources(endedCpu: NodeJS.ResourceUsage): RunBundleManifest["resources"] {
    const resources: RunBundleManifest["resources"] = {
      cpuUserMs: Math.max(0, (endedCpu.userCPUTime - startedCpu.userCPUTime) / 1000),
      cpuSystemMs: Math.max(0, (endedCpu.systemCPUTime - startedCpu.systemCPUTime) / 1000),
      peakRssBytes: maxRssBytes(endedCpu.maxRSS),
      runtime: `bun ${Bun.version}`,
    };
    setDefined(resources, "runner", runnerName(options.env ?? process.env));
    return resources;
  }

  function refreshCaptureStatus(manifest: RunBundleManifest): void {
    manifest.capture.truncated =
      signalTruncated || artifacts.some((artifact) => artifact.truncated);
    manifest.capture.errors = captureErrors.slice(0, 100);
    if (captureErrors.length > 0) manifest.capture.completeness = "partial";
  }

  async function exportAndWriteManifest(
    manifest: RunBundleManifest,
    metrics: RunMetricsSnapshot,
    deadline: number,
  ): Promise<void> {
    const otlpResult = await withDeadline(
      exportRunTelemetry({
        env: options.env ?? process.env,
        manifest,
        spans: spanRecords,
        logs: logRecords,
        metrics,
      }),
      deadline,
    );
    manifest.export.otlp = otlpResult ?? "timed-out";
    manifest.capture.finalizationTimedOut = otlpResult === undefined;
    const temporaryManifest = path.join(directory, "run.json.tmp");
    await writePrivateFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporaryManifest, path.join(directory, "run.json"));
    await rm(activePath, { force: true });
  }

  async function addRecorderArtifact(artifact: {
    kind: RunBundleArtifact["kind"];
    name: string;
    mediaType: string;
    content: string;
    sensitive: boolean;
  }): Promise<void> {
    if (options.mode === "metadata") return;
    try {
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(artifact.name)) {
        throw new Error(`Invalid run artifact name: ${artifact.name}`);
      }
      const redacted = redactor.redact(artifact.content).value;
      const original = Buffer.from(redacted, "utf8");
      const originalSha256 = createHash("sha256").update(original).digest("hex");
      const priority = artifactPriority(artifact.kind, artifact.name);
      await evictLowerPriorityArtifacts(original.byteLength, priority);
      const remaining = Math.max(0, artifactLimitBytes - artifactBytes);
      const stored = truncateUtf8(original, remaining);
      const relativePath = `artifacts/${artifact.name}`;
      await mkdir(path.join(directory, "artifacts"), { recursive: true, mode: 0o700 });
      if (stored.byteLength > 0 || original.byteLength === 0) {
        await writePrivateBuffer(path.join(directory, relativePath), stored);
      }
      artifactBytes += stored.byteLength;
      const descriptor: RunBundleArtifact = {
        kind: artifact.kind,
        path: relativePath,
        mediaType: artifact.mediaType,
        sizeBytes: stored.byteLength,
        sha256: createHash("sha256").update(stored).digest("hex"),
        sensitive: artifact.sensitive,
        truncated: stored.byteLength < original.byteLength,
        ...(stored.byteLength < original.byteLength
          ? {
              originalSizeBytes: original.byteLength,
              originalSha256,
              ...(stored.byteLength === 0 ? { omitted: true } : {}),
            }
          : {}),
      };
      artifacts.push(descriptor);
      artifactPriorities.set(descriptor, priority);
    } catch (error) {
      captureErrors.push(safeErrorMessage(error));
    }
  }

  async function evictLowerPriorityArtifacts(
    desiredBytes: number,
    incomingPriority: number,
  ): Promise<void> {
    if (artifactBytes + desiredBytes <= artifactLimitBytes) return;
    const candidates = artifacts
      .filter(
        (artifact) =>
          !artifact.omitted &&
          artifact.sizeBytes > 0 &&
          (artifactPriorities.get(artifact) ?? 0) < incomingPriority,
      )
      .sort(
        (left, right) =>
          (artifactPriorities.get(left) ?? 0) - (artifactPriorities.get(right) ?? 0) ||
          left.path.localeCompare(right.path),
      );
    for (const candidate of candidates) {
      if (artifactBytes + desiredBytes <= artifactLimitBytes) break;
      await omitArtifact(candidate);
    }
  }

  async function enforceFinalBundleLimit(
    manifest: RunBundleManifest,
    metricsBytes: number,
  ): Promise<void> {
    for (;;) {
      const manifestBytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`);
      if (artifactBytes + spanBytes + logBytes + metricsBytes + manifestBytes <= bundleLimitBytes) {
        return;
      }
      const candidate = artifacts
        .filter((artifact) => !artifact.omitted && artifact.sizeBytes > 0)
        .sort(
          (left, right) =>
            (artifactPriorities.get(left) ?? 0) - (artifactPriorities.get(right) ?? 0) ||
            left.path.localeCompare(right.path),
        )[0];
      if (!candidate) {
        captureErrors.push("Run bundle metadata exceeded the configured bundle limit");
        return;
      }
      await omitArtifact(candidate);
    }
  }

  async function omitArtifact(artifact: RunBundleArtifact): Promise<void> {
    const previousSize = artifact.sizeBytes;
    const originalSizeBytes = artifact.originalSizeBytes ?? previousSize;
    const originalSha256 = artifact.originalSha256 ?? artifact.sha256;
    await rm(path.join(directory, artifact.path), { force: true });
    artifactBytes -= previousSize;
    artifact.sizeBytes = 0;
    artifact.sha256 = emptySha256;
    artifact.truncated = true;
    artifact.originalSizeBytes = originalSizeBytes;
    artifact.originalSha256 = originalSha256;
    artifact.omitted = true;
  }
}

function observeAttemptEvent(
  event: RunAgentEvent,
  context: {
    suffix: string;
    attempt: Parameters<RunObserver["beginAgentAttempt"]>[0];
    attemptStartedAt: Date;
    attemptStartedMs: number;
    firstResponseRecorded: boolean;
    markFirstResponseRecorded(): void;
    openSpan: (
      key: string,
      name: string,
      category: RunSpanRecord["category"],
      attributes: RunSpanRecord["attributes"],
    ) => void;
    closeSpan: (
      key: string,
      status: RunSpanRecord["status"],
      durationMs?: number,
      attributes?: RunSpanRecord["attributes"],
    ) => void;
    queueSpan(span: RunSpanRecord): void;
    executionId: string;
    rootSpanId: string;
  },
): void {
  switch (event.kind) {
    case "first-response":
      observeFirstResponse(context);
      return;
    case "tool-start":
      observeToolStart(event, context);
      return;
    case "tool-end":
      observeToolEnd(event, context);
      return;
    default:
      observeInternalAttemptEvent(event, context);
  }
}

type AttemptEventContext = Parameters<typeof observeAttemptEvent>[1];

function observeFirstResponse(context: AttemptEventContext): void {
  if (context.firstResponseRecorded) return;
  context.markFirstResponseRecorded();
  const endedAt = new Date();
  context.queueSpan({
    formatVersion: 1,
    traceId: context.executionId,
    spanId: randomBytes(8).toString("hex"),
    parentSpanId: context.rootSpanId,
    name: "gen_ai.time_to_first_token",
    category: "model",
    startedAt: context.attemptStartedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: Math.max(0, Date.now() - context.attemptStartedMs),
    status: "ok",
    attributes: {
      [ATTR_GEN_AI_AGENT_NAME]: context.attempt.agent,
      [ATTR_GEN_AI_PROVIDER_NAME]: context.attempt.provider,
      [ATTR_GEN_AI_REQUEST_MODEL]: context.attempt.model,
      "pipr.attempt.type": context.attempt.attemptType,
    },
  });
}

function observeToolStart(
  event: Extract<RunAgentEvent, { id: string }>,
  context: AttemptEventContext,
): void {
  const attributes: RunSpanRecord["attributes"] = {
    [ATTR_GEN_AI_TOOL_NAME]: event.name,
    "pipr.attempt.type": context.attempt.attemptType,
  };
  setDefined(attributes, "pipr.tool.input_bytes", event.contentBytes);
  setDefined(attributes, "pipr.tool.input_hash", event.contentHash);
  context.openSpan(`tool:${context.suffix}:${event.id}`, "gen_ai.execute_tool", "tool", attributes);
}

function observeToolEnd(
  event: Extract<RunAgentEvent, { id: string }>,
  context: AttemptEventContext,
): void {
  const attributes: RunSpanRecord["attributes"] = { [ATTR_GEN_AI_TOOL_NAME]: event.name };
  setDefined(attributes, "pipr.tool.output_bytes", event.contentBytes);
  setDefined(attributes, "pipr.tool.output_hash", event.contentHash);
  context.closeSpan(
    `tool:${context.suffix}:${event.id}`,
    event.failed ? "error" : "ok",
    undefined,
    attributes,
  );
}

function observeInternalAttemptEvent(
  event: Extract<
    RunAgentEvent,
    { kind: "retry-start" | "retry-end" | "compaction-start" | "compaction-end" }
  >,
  context: AttemptEventContext,
): void {
  const operation = event.kind.startsWith("retry") ? "retry" : "compaction";
  const key = `internal:${operation}:${context.suffix}`;
  if (event.kind.endsWith("start")) {
    const attributes: RunSpanRecord["attributes"] = {
      "pipr.attempt.type": context.attempt.attemptType,
    };
    if (event.kind === "retry-start") {
      setDefined(attributes, "pipr.retry.backoff_ms", event.delayMs);
    }
    context.openSpan(key, `pipr.agent.${operation}`, "internal", attributes);
    return;
  }
  context.closeSpan(key, "ok");
}

type OpenSpan = {
  spanId: string;
  name: string;
  category: RunSpanRecord["category"];
  attributes: RunSpanRecord["attributes"];
  startedAt: Date;
  startedMs: number;
};

const phaseSpanNames: Readonly<Record<string, string>> = {
  workspace: "pipr.workspace.prepare",
  "parse event": "pipr.event.parse",
  "fetch trusted base": "pipr.config.fetch_trusted_base",
  "load trusted config": "pipr.config.load_trusted",
  "checkout head": "pipr.workspace.checkout_head",
  "load change request": "pipr.change.load",
  "load prior review state": "pipr.prior_state.load_review",
  "load prior main comment": "pipr.prior_state.load_main_comment",
  "load inline thread contexts": "pipr.prior_state.load_threads",
  "check command permission": "pipr.command.check_permission",
  "publish verifier thread actions": "pipr.publish.verifier_thread_actions",
};

function phaseNameFromStart(event: string): string | undefined {
  if (!event.endsWith(" start")) return undefined;
  const name = event.slice(0, -" start".length);
  return phaseSpanNames[name] ? name : undefined;
}

function phaseNameFromEnd(event: string): { name: string; failed: boolean } | undefined {
  for (const suffix of [" ok", " failed"] as const) {
    if (!event.endsWith(suffix)) continue;
    const name = event.slice(0, -suffix.length);
    return phaseSpanNames[name] ? { name, failed: suffix === " failed" } : undefined;
  }
  return undefined;
}

function phaseSpanName(name: string): string {
  return phaseSpanNames[name] ?? `pipr.phase.${name.replaceAll(" ", "_")}`;
}

function modelSpanKey(record: RuntimeLogRecord): string {
  const attemptId = stringField(record, "attemptId");
  if (attemptId) return `model:${attemptId}`;
  return `model:${stringField(record, "agent")}:${stringField(record, "provider")}:${stringField(record, "model")}:${numberField(record, "attemptNumber") ?? 0}`;
}

function modelSpanAttributes(record: RuntimeLogRecord): RunSpanRecord["attributes"] {
  return {
    [ATTR_GEN_AI_OPERATION_NAME]: "chat",
    [ATTR_GEN_AI_AGENT_NAME]: stringField(record, "agent"),
    [ATTR_GEN_AI_PROVIDER_NAME]: stringField(record, "provider"),
    [ATTR_GEN_AI_REQUEST_MODEL]: stringField(record, "model"),
    "pipr.attempt.type": stringField(record, "attemptType"),
    "pipr.attempt.number": numberField(record, "attemptNumber") ?? 0,
    "pipr.attempt.id": stringField(record, "attemptId"),
    "pipr.prompt.bytes": numberField(record, "promptBytes") ?? 0,
  };
}

function modelResultAttributes(record: RuntimeLogRecord): RunSpanRecord["attributes"] {
  const attributes: RunSpanRecord["attributes"] = {
    "pipr.response.stdout_bytes": numberField(record, "stdoutBytes") ?? 0,
    "pipr.response.stderr_bytes": numberField(record, "stderrBytes") ?? 0,
    "pipr.process.exit_code": numberField(record, "exitCode") ?? -1,
  };
  setDefined(attributes, ATTR_GEN_AI_USAGE_INPUT_TOKENS, numberField(record, "inputTokens"));
  setDefined(attributes, ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, numberField(record, "outputTokens"));
  setDefined(attributes, "pipr.usage.cost_usd", numberField(record, "costUsd"));
  return attributes;
}

function instantLogSpanName(event: string): string | undefined {
  return {
    "diff manifest": "pipr.diff.construct",
    "review validated": "pipr.review.validate",
  }[event];
}

function setDefined<T, Key extends keyof T>(target: T, key: Key, value: T[Key] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function stringField(record: RuntimeLogRecord, name: string): string {
  const value = record.fields[name];
  return typeof value === "string" ? value : "unknown";
}

function numberField(record: RuntimeLogRecord, name: string): number | undefined {
  const value = record.fields[name];
  return typeof value === "number" ? value : undefined;
}

function booleanField(record: RuntimeLogRecord, name: string): boolean | undefined {
  const value = record.fields[name];
  return typeof value === "boolean" ? value : undefined;
}

function numericLogAttributes(record: RuntimeLogRecord): RunSpanRecord["attributes"] {
  return Object.fromEntries(
    Object.entries(record.fields)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([key, value]) => [`pipr.${key.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}`, value]),
  );
}

function resourceSnapshot(): { cpuUserMs: number; cpuSystemMs: number; peakRssBytes: number } {
  const usage = process.resourceUsage();
  return {
    cpuUserMs: usage.userCPUTime / 1000,
    cpuSystemMs: usage.systemCPUTime / 1000,
    peakRssBytes: maxRssBytes(usage.maxRSS),
  };
}

function maxRssBytes(maxRss: number): number {
  return Math.max(0, process.platform === "darwin" ? maxRss : maxRss * 1024);
}

export function combineRuntimeLogSinks(
  first: RuntimeLogSink | undefined,
  second: RuntimeLogSink | undefined,
): RuntimeLogSink | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    log(record) {
      first.log(record);
      second.log(record);
    },
    async group(name, run) {
      return await first.group(name, async () => await second.group(name, run));
    },
  };
}

function normalizeLogFields(
  fields: RuntimeLogRecord["fields"],
  redactor: ReturnType<typeof createKnownSecretRedactor>,
  onTruncate: () => void,
): RunLogRecord["fields"] {
  const redacted: RunLogRecord["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    const boundedKey = boundLogString(key, 200, onTruncate);
    if (!boundedKey) continue;
    redacted[boundedKey] =
      typeof value === "string"
        ? boundLogString(redactor.redact(value).value, 2000, onTruncate)
        : typeof value === "number" || typeof value === "boolean"
          ? value
          : normalizeLogArray(value, redactor, onTruncate);
  }
  return redacted;
}

function normalizeLogArray(
  value: readonly string[],
  redactor: ReturnType<typeof createKnownSecretRedactor>,
  onTruncate: () => void,
): string[] {
  if (value.length > 100) onTruncate();
  return value
    .slice(0, 100)
    .map((item) => boundLogString(redactor.redact(item).value, 2000, onTruncate));
}

function boundLogString(value: string, maximum: number, onTruncate: () => void): string {
  if (value.length <= maximum) return value;
  onTruncate();
  return value.slice(0, maximum);
}

async function ensureSafeDirectory(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Run bundle root must be a real directory: ${directory}`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Run bundle root must be a real directory: ${directory}`);
    }
  }
  await chmod(directory, 0o700);
}

type DirectoryOwner = { uid: number; gid: number };

async function nearestDirectoryOwner(directory: string): Promise<DirectoryOwner> {
  let candidate = directory;
  while (true) {
    try {
      const stats = await lstat(candidate);
      return { uid: stats.uid, gid: stats.gid };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function preserveStoreOwnership(
  rootDirectory: string,
  bundleDirectory: string,
  owner: DirectoryOwner,
): Promise<void> {
  if (process.getuid?.() !== 0) return;
  await chownTree(bundleDirectory, owner);
  await chown(rootDirectory, owner.uid, owner.gid);
}

async function chownTree(directory: string, owner: DirectoryOwner): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await chownTree(entryPath, owner);
    await chown(entryPath, owner.uid, owner.gid);
  }
  await chown(directory, owner.uid, owner.gid);
}

async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

async function writePrivateBuffer(filePath: string, contents: Buffer): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function truncateUtf8(contents: Buffer, maxBytes: number): Buffer {
  if (contents.byteLength <= maxBytes) return contents;
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    const candidate = Buffer.from(contents.subarray(0, end).toString("utf8"), "utf8");
    if (candidate.byteLength <= maxBytes) return candidate;
    end -= 1;
  }
  return Buffer.alloc(0);
}

function artifactPriority(kind: RunBundleArtifact["kind"], name: string): number {
  if (kind === "validation") return 1_000_000;
  if (kind === "publication-plan") {
    return /publication-(?:result|error)\.json$/.test(name) ? 1_010_000 : 990_000;
  }
  if (kind === "diff-manifest") return 980_000;
  const attempt = /-(\d+)-(?:initial|retry|repair|fallback)\./.exec(name);
  if (!attempt) return 970_000;
  const sequence = Number(attempt[1]);
  const kindPriority = kind === "stderr" ? 3 : kind === "output" ? 2 : 1;
  return sequence * 10 + kindPriority;
}

function emptyMetrics(): RunMetricsSnapshot {
  return { formatVersion: 1, counters: [], histograms: [] };
}

function runMetrics(result: RunRecorderFinish, durationMs: number): RunMetricsSnapshot {
  const attributes = { runKind: result.kind, outcome: result.outcome } as const;
  return {
    formatVersion: 1,
    counters: [{ name: "pipr.run.count", value: 1, attributes }],
    histograms: [
      {
        name: "pipr.run.duration",
        count: 1,
        sum: durationMs,
        min: durationMs,
        max: durationMs,
        attributes,
      },
    ],
  };
}

function runnerName(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GITHUB_ACTIONS === "true") return "github-actions";
  if (env.GITLAB_CI === "true") return "gitlab-ci";
  if (env.TF_BUILD === "True" || env.TF_BUILD === "true") return "azure-pipelines";
  if (env.BITBUCKET_BUILD_NUMBER) return "bitbucket-pipelines";
  return undefined;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : "run capture failed";
}

async function withDeadline<T>(promise: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = Math.max(0, deadline - Date.now() - 50);
  if (remaining === 0) return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), remaining);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
