import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BasicTracerProvider,
  BatchSpanProcessor,
  type IdGenerator,
  ParentBasedSampler,
  RandomIdGenerator,
  type Sampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type {
  RunBundleManifest,
  RunLogRecord,
  RunMetricsSnapshot,
  RunSpanRecord,
} from "@usepipr/sdk";

export type OtlpExportStatus = "disabled" | "succeeded" | "failed";

type OtlpSignal = "traces" | "metrics" | "logs";

type TelemetryOptions = Parameters<typeof exportRunTelemetry>[0];
type Shutdown = () => Promise<void>;

export async function exportRunTelemetry(options: {
  env: NodeJS.ProcessEnv;
  manifest: RunBundleManifest;
  spans: RunSpanRecord[];
  logs: RunLogRecord[];
  metrics: RunMetricsSnapshot;
}): Promise<OtlpExportStatus> {
  const enabledSignals = signalEndpoints(options.env);
  if (enabledSignals.size === 0 || options.env.OTEL_SDK_DISABLED?.toLowerCase() === "true") {
    return "disabled";
  }
  if (!usesHttpProtobuf(options.env)) return "failed";
  const resources = telemetryResources(options.manifest);
  const shutdown: Shutdown[] = [];

  try {
    let rootContext: Context = ROOT_CONTEXT;
    if (enabledSignals.has("traces")) {
      const traces = startTraceExport(options, resources.diagnostic);
      rootContext = traces.rootContext;
      shutdown.push(traces.shutdown);
    }
    if (enabledSignals.has("logs")) {
      shutdown.push(startLogExport(options, resources.diagnostic, rootContext));
    }
    if (enabledSignals.has("metrics")) {
      shutdown.push(startMetricExport(options, resources.metrics));
    }
    await closeExporters(shutdown);
    return "succeeded";
  } catch {
    await Promise.allSettled(shutdown.map((close) => close()));
    return "failed";
  }
}

function telemetryResources(manifest: RunBundleManifest) {
  const common = { "service.name": "pipr", "service.version": manifest.pipr.version };
  const diagnosticAttributes: Attributes = {
    ...common,
    "pipr.execution.id": manifest.executionId,
  };
  if (manifest.workId) diagnosticAttributes["pipr.work.id"] = manifest.workId;
  if (manifest.repository) {
    diagnosticAttributes["pipr.host"] = manifest.repository.host;
    diagnosticAttributes["pipr.repository"] = manifest.repository.repository;
    if (manifest.repository.changeNumber) {
      diagnosticAttributes["pipr.change.number"] = manifest.repository.changeNumber;
    }
  }
  return {
    diagnostic: resourceFromAttributes(diagnosticAttributes),
    metrics: resourceFromAttributes({
      ...common,
      ...(manifest.repository ? { "pipr.host": manifest.repository.host } : {}),
    }),
  };
}

function startTraceExport(
  options: TelemetryOptions,
  resource: ReturnType<typeof resourceFromAttributes>,
) {
  const exporter = new OTLPTraceExporter(exporterOptions(options.env, "traces"));
  const provider = new BasicTracerProvider({
    resource,
    idGenerator: fixedTraceIdGenerator(options.manifest.executionId),
    sampler: samplerFromEnvironment(options.env),
    spanProcessors: [new BatchSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("@usepipr/runtime", options.manifest.pipr.version);
  const rootRecord = options.spans.find((span) => span.category === "run");
  const rootSpan = tracer.startSpan(
    rootSpanName(rootRecord),
    {
      startTime: timestamp(rootSpanStart(rootRecord, options.manifest)),
      attributes: rootTraceAttributes(options.manifest, rootRecord),
    },
    ROOT_CONTEXT,
  );
  const rootContext = trace.setSpan(ROOT_CONTEXT, rootSpan);
  for (const span of options.spans) exportChildSpan(tracer, span, rootRecord, rootContext);
  rootSpan.setStatus({ code: otelStatus(rootRecord?.status) });
  rootSpan.end(timestamp(rootSpanEnd(rootRecord, options.manifest)));
  return { rootContext, shutdown: async () => await provider.shutdown() };
}

function rootSpanName(root: RunSpanRecord | undefined): string {
  return root ? root.name : "pipr.run";
}

function rootSpanStart(root: RunSpanRecord | undefined, manifest: RunBundleManifest): string {
  return root ? root.startedAt : manifest.startedAt;
}

function rootSpanEnd(root: RunSpanRecord | undefined, manifest: RunBundleManifest): string {
  return root?.endedAt ?? manifest.endedAt ?? manifest.startedAt;
}

function exportChildSpan(
  tracer: ReturnType<BasicTracerProvider["getTracer"]>,
  span: RunSpanRecord,
  rootRecord: RunSpanRecord | undefined,
  rootContext: Context,
): void {
  if (span === rootRecord) return;
  const exported = tracer.startSpan(
    span.name,
    { startTime: timestamp(span.startedAt), attributes: toOtelAttributes(span.attributes) },
    rootContext,
  );
  exported.setStatus({ code: otelStatus(span.status) });
  exported.end(timestamp(span.endedAt ?? span.startedAt));
}

function rootTraceAttributes(
  manifest: RunBundleManifest,
  root: RunSpanRecord | undefined,
): Attributes {
  return {
    ...toOtelAttributes(root?.attributes ?? {}),
    "pipr.execution.id": manifest.executionId,
    ...(manifest.workId ? { "pipr.work.id": manifest.workId } : {}),
  };
}

function otelStatus(status: RunSpanRecord["status"] | undefined): SpanStatusCode {
  return status === "error" ? SpanStatusCode.ERROR : SpanStatusCode.OK;
}

function startLogExport(
  options: TelemetryOptions,
  resource: ReturnType<typeof resourceFromAttributes>,
  rootContext: Context,
): Shutdown {
  const provider = new LoggerProvider({
    resource,
    processors: [
      new BatchLogRecordProcessor({
        exporter: new OTLPLogExporter(exporterOptions(options.env, "logs")),
      }),
    ],
  });
  const logger = provider.getLogger("@usepipr/runtime", options.manifest.pipr.version);
  for (const log of options.logs) {
    logger.emit({
      eventName: log.event,
      body: log.event,
      timestamp: timestamp(log.timestamp),
      severityText: log.level.toUpperCase(),
      attributes: externalLogAttributes(log),
      context: rootContext,
    });
  }
  return async () => await provider.shutdown();
}

function startMetricExport(
  options: TelemetryOptions,
  resource: ReturnType<typeof resourceFromAttributes>,
): Shutdown {
  const reader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter(exporterOptions(options.env, "metrics")),
  });
  const provider = new MeterProvider({ resource, readers: [reader] });
  const meter = provider.getMeter("@usepipr/runtime", options.manifest.pipr.version);
  for (const counter of options.metrics.counters) {
    meter.createCounter(counter.name).add(counter.value, counter.attributes);
  }
  for (const histogram of options.metrics.histograms) {
    meter.createHistogram(histogram.name).record(histogram.sum, histogram.attributes);
  }
  return async () => await provider.shutdown();
}

async function closeExporters(shutdown: Shutdown[]): Promise<void> {
  await Promise.all(shutdown.map((close) => close()));
}

function signalEndpoints(env: NodeJS.ProcessEnv): Set<OtlpSignal> {
  const signals = new Set<OtlpSignal>();
  const generic = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  for (const signal of ["traces", "metrics", "logs"] as const) {
    const exporter = env[`OTEL_${signal.toUpperCase()}_EXPORTER`];
    if (
      exporter
        ?.split(",")
        .map((value) => value.trim())
        .includes("none")
    )
      continue;
    if (
      generic ||
      env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_ENDPOINT`] ||
      exporter
        ?.split(",")
        .map((value) => value.trim())
        .includes("otlp")
    ) {
      signals.add(signal);
    }
  }
  return signals;
}

function usesHttpProtobuf(env: NodeJS.ProcessEnv): boolean {
  const protocols = [
    env.OTEL_EXPORTER_OTLP_PROTOCOL,
    env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL,
    env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL,
    env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL,
  ].filter((value): value is string => value !== undefined);
  return protocols.every((protocol) => protocol.toLowerCase() === "http/protobuf");
}

function exporterOptions(
  env: NodeJS.ProcessEnv,
  signal: OtlpSignal,
): {
  url?: string;
  headers?: Record<string, string>;
  timeoutMillis?: number;
} {
  const prefix = `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}`;
  const specificEndpoint = env[`${prefix}_ENDPOINT`];
  const genericEndpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const url = specificEndpoint ?? appendSignalPath(genericEndpoint, signal);
  const headers = {
    ...parseHeaders(env.OTEL_EXPORTER_OTLP_HEADERS),
    ...parseHeaders(env[`${prefix}_HEADERS`]),
  };
  const configuredTimeout = positiveInteger(
    env[`${prefix}_TIMEOUT`] ?? env.OTEL_EXPORTER_OTLP_TIMEOUT,
  );
  return {
    ...(url ? { url } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    timeoutMillis: Math.min(configuredTimeout ?? 2_000, 2_000),
  };
}

function appendSignalPath(endpoint: string | undefined, signal: OtlpSignal): string | undefined {
  if (!endpoint) return undefined;
  return `${endpoint.replace(/\/+$/, "")}/v1/${signal}`;
}

function parseHeaders(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value
      .split(",")
      .map((part) => part.split("=", 2))
      .filter((entry): entry is [string, string] => entry.length === 2 && entry[0].trim() !== "")
      .map(([key, headerValue]) => [
        decodeURIComponent(key.trim()),
        decodeURIComponent(headerValue),
      ]),
  );
}

function positiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function samplerFromEnvironment(env: NodeJS.ProcessEnv): Sampler {
  const ratio = Number(env.OTEL_TRACES_SAMPLER_ARG ?? "1");
  const ratioSampler = new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 1);
  switch (env.OTEL_TRACES_SAMPLER?.toLowerCase()) {
    case "always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
      return ratioSampler;
    case "parentbased_always_off":
      return new ParentBasedSampler({ root: new AlwaysOffSampler() });
    case "parentbased_traceidratio":
      return new ParentBasedSampler({ root: ratioSampler });
    case "parentbased_always_on":
      return new ParentBasedSampler({ root: new AlwaysOnSampler() });
    default:
      return new AlwaysOnSampler();
  }
}

function fixedTraceIdGenerator(traceId: string): IdGenerator {
  const random = new RandomIdGenerator();
  return {
    generateTraceId: () => traceId,
    generateSpanId: () => random.generateSpanId(),
  };
}

function externalLogAttributes(log: RunLogRecord): Attributes {
  const attributes: Attributes = {
    "pipr.log.sequence": log.sequence,
    "pipr.log.level": log.level,
  };
  for (const [key, value] of Object.entries(log.fields)) {
    if (!isContentFreeField(key)) continue;
    attributes[`pipr.log.${key}`] = Array.isArray(value) ? value.map(String) : value;
  }
  return attributes;
}

function toOtelAttributes(values: RunSpanRecord["attributes"]): Attributes {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      Array.isArray(value) ? value.map(String) : value,
    ]),
  );
}

function isContentFreeField(key: string): boolean {
  return /(?:^|[._-])(id|name|status|outcome|kind|type|provider|model|agent|task|host|durationMs|bytes|count|tokens|costUsd|exitCode)$/i.test(
    key,
  );
}

function timestamp(value: string): Date {
  return new Date(value);
}
