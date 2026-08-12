import { randomBytes } from "node:crypto";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";
import type { RunSpanRecord } from "@usepipr/sdk";
import type { RuntimeLogRecord } from "../shared/logging.js";
import type { RunAgentEvent, RunObserver } from "./types.js";

export function observeAttemptEvent(
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

export type OpenSpan = {
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
  "publish review progress": "pipr.publish.review_progress",
  "publish verifier thread actions": "pipr.publish.verifier_thread_actions",
};

export function phaseNameFromStart(event: string): string | undefined {
  if (!event.endsWith(" start")) return undefined;
  const name = event.slice(0, -" start".length);
  return phaseSpanNames[name] ? name : undefined;
}

export function phaseNameFromEnd(event: string): { name: string; failed: boolean } | undefined {
  for (const suffix of [" ok", " failed"] as const) {
    if (!event.endsWith(suffix)) continue;
    const name = event.slice(0, -suffix.length);
    return phaseSpanNames[name] ? { name, failed: suffix === " failed" } : undefined;
  }
  return undefined;
}

export function phaseSpanName(name: string): string {
  return phaseSpanNames[name] ?? `pipr.phase.${name.replaceAll(" ", "_")}`;
}

export function modelSpanKey(record: RuntimeLogRecord): string {
  const attemptId = stringField(record, "attemptId");
  if (attemptId) return `model:${attemptId}`;
  return `model:${stringField(record, "agent")}:${stringField(record, "provider")}:${stringField(record, "model")}:${numberField(record, "attemptNumber") ?? 0}`;
}

export function modelSpanAttributes(record: RuntimeLogRecord): RunSpanRecord["attributes"] {
  const attributes: RunSpanRecord["attributes"] = {
    [ATTR_GEN_AI_OPERATION_NAME]: "chat",
    [ATTR_GEN_AI_AGENT_NAME]: stringField(record, "agent"),
    [ATTR_GEN_AI_PROVIDER_NAME]: stringField(record, "provider"),
    [ATTR_GEN_AI_REQUEST_MODEL]: stringField(record, "model"),
    "pipr.attempt.type": stringField(record, "attemptType"),
    "pipr.attempt.number": numberField(record, "attemptNumber") ?? 0,
    "pipr.attempt.id": stringField(record, "attemptId"),
    "pipr.prompt.bytes": numberField(record, "promptBytes") ?? 0,
  };
  setDefined(attributes, "pipr.task.name", optionalStringField(record, "task"));
  setDefined(attributes, "pipr.auth.mode", optionalStringField(record, "authMode"));
  setDefined(attributes, "pipr.shard.index", numberField(record, "shardIndex"));
  setDefined(attributes, "pipr.shard.count", numberField(record, "shardCount"));
  return attributes;
}

export function modelResultAttributes(record: RuntimeLogRecord): RunSpanRecord["attributes"] {
  const attributes: RunSpanRecord["attributes"] = {
    "pipr.response.stdout_bytes": numberField(record, "stdoutBytes") ?? 0,
    "pipr.response.stderr_bytes": numberField(record, "stderrBytes") ?? 0,
    "pipr.process.exit_code": numberField(record, "exitCode") ?? -1,
  };
  setDefined(attributes, ATTR_GEN_AI_USAGE_INPUT_TOKENS, numberField(record, "inputTokens"));
  setDefined(attributes, ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, numberField(record, "outputTokens"));
  setDefined(attributes, "pipr.usage.cache_read_tokens", numberField(record, "cacheReadTokens"));
  setDefined(attributes, "pipr.usage.cache_write_tokens", numberField(record, "cacheWriteTokens"));
  setDefined(
    attributes,
    "pipr.usage.cache_status",
    optionalStringField(record, "cacheUsageStatus"),
  );
  setDefined(attributes, "pipr.usage.cost_usd", numberField(record, "costUsd"));
  return attributes;
}

export function instantLogSpanName(event: string): string | undefined {
  return {
    "diff manifest": "pipr.diff.construct",
    "diff structural analysis": "pipr.diff.structural_analysis",
    "diff manifest sharded": "pipr.diff.sharding",
    "agent run budget": "pipr.agent.run_budget",
    "review validated": "pipr.review.validate",
  }[event];
}

export function instantLogSpanCategory(event: string): RunSpanRecord["category"] {
  return event === "diff manifest sharded" || event === "agent run budget" ? "internal" : "phase";
}

export function addInstantLogAttributes(
  record: RuntimeLogRecord,
  attributes: RunSpanRecord["attributes"],
): void {
  if (record.event === "diff structural analysis") {
    setDefined(attributes, "pipr.structural.status", optionalStringField(record, "status"));
    setDefined(attributes, "pipr.structural.version", optionalStringField(record, "version"));
    setDefined(attributes, "pipr.structural.reason", optionalStringField(record, "reason"));
  }
  if (record.event === "diff manifest sharded") {
    delete attributes["pipr.shardCount"];
    setDefined(attributes, "pipr.agent.name", optionalStringField(record, "agent"));
    setDefined(attributes, "pipr.task.name", optionalStringField(record, "task"));
    setDefined(attributes, "pipr.shard.kind", optionalStringField(record, "kind"));
    setDefined(attributes, "pipr.shard.count", numberField(record, "shardCount"));
  }
}

export function setDefined<T, Key extends keyof T>(
  target: T,
  key: Key,
  value: T[Key] | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

export function stringField(record: RuntimeLogRecord, name: string): string {
  const value = record.fields[name];
  return typeof value === "string" ? value : "unknown";
}

function optionalStringField(record: RuntimeLogRecord, name: string): string | undefined {
  const value = record.fields[name];
  return typeof value === "string" ? value : undefined;
}

export function numberField(record: RuntimeLogRecord, name: string): number | undefined {
  const value = record.fields[name];
  return typeof value === "number" ? value : undefined;
}

export function booleanField(record: RuntimeLogRecord, name: string): boolean | undefined {
  const value = record.fields[name];
  return typeof value === "boolean" ? value : undefined;
}

export function numericLogAttributes(record: RuntimeLogRecord): RunSpanRecord["attributes"] {
  return Object.fromEntries(
    Object.entries(record.fields)
      .filter((entry): entry is [string, number] => typeof entry[1] === "number")
      .map(([key, value]) => [`pipr.${key.replaceAll(/[^a-zA-Z0-9_.-]/g, "_")}`, value]),
  );
}

export function resourceSnapshot(): {
  cpuUserMs: number;
  cpuSystemMs: number;
  peakRssBytes: number;
} {
  const usage = process.resourceUsage();
  return {
    cpuUserMs: usage.userCPUTime / 1000,
    cpuSystemMs: usage.systemCPUTime / 1000,
    peakRssBytes: maxRssBytes(usage.maxRSS),
  };
}

export function maxRssBytes(maxRss: number): number {
  return Math.max(0, process.platform === "darwin" ? maxRss : maxRss * 1024);
}
