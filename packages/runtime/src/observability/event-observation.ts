import { randomBytes } from "node:crypto";
import {
  ATTR_GEN_AI_AGENT_NAME,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_RESPONSE_MODEL,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from "@opentelemetry/semantic-conventions/incubating";
import type { RunSpanRecord } from "@usepipr/sdk";
import type { RuntimeLogRecord } from "../shared/logging.js";
import type { RunAgentEvent, RunAgentUsage, RunObserver } from "./types.js";

/** What the recorder learns about one agent attempt from its harness events. */
export type AttemptRecord = {
  turns: number;
  /** Per response model: summed turn usage and turn count. */
  models: Map<string, RunAgentUsage & { turns: number }>;
  conversation?: Extract<RunAgentEvent, { kind: "conversation" }>;
};

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
    hasOpenSpan(key: string): boolean;
    queueSpan(span: RunSpanRecord): void;
    executionId: string;
    rootSpanId: string;
    record: AttemptRecord;
  },
): void {
  switch (event.kind) {
    case "first-response":
      observeFirstResponse(context);
      return;
    case "turn-start":
      context.openSpan(modelSpanKey(context.suffix), "gen_ai.chat", "model", {
        ...agentSpanAttributes(context.attempt, context.suffix, "chat"),
        "pipr.turn.index": context.record.turns + 1,
      });
      return;
    case "turn-end":
      observeTurnEnd(event, context);
      return;
    case "conversation":
      context.record.conversation = event;
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

type AttemptOptions = Parameters<RunObserver["beginAgentAttempt"]>[0];

function modelSpanKey(suffix: string): string {
  return `model:${suffix}`;
}

/** Attributes shared by an attempt's agent span and its per-turn model spans. */
export function agentSpanAttributes(
  attempt: AttemptOptions,
  suffix: string,
  operation: "invoke_agent" | "chat",
): RunSpanRecord["attributes"] {
  const attributes: RunSpanRecord["attributes"] = {
    [ATTR_GEN_AI_OPERATION_NAME]: operation,
    [ATTR_GEN_AI_AGENT_NAME]: attempt.agent.slice(0, 200),
    [ATTR_GEN_AI_PROVIDER_NAME]: attempt.provider,
    [ATTR_GEN_AI_REQUEST_MODEL]: attempt.model,
    "pipr.attempt.type": attempt.attemptType,
    "pipr.attempt.number": attempt.attemptNumber,
    "pipr.attempt.id": suffix,
  };
  setDefined(attributes, "pipr.task.name", attempt.task);
  setDefined(attributes, "pipr.auth.mode", attempt.authMode);
  setDefined(attributes, "pipr.shard.index", attempt.shardIndex);
  setDefined(attributes, "pipr.shard.count", attempt.shardCount);
  return attributes;
}

export function usageAttributes(usage: Partial<RunAgentUsage>): RunSpanRecord["attributes"] {
  const attributes: RunSpanRecord["attributes"] = {};
  setDefined(attributes, ATTR_GEN_AI_USAGE_INPUT_TOKENS, usage.inputTokens);
  setDefined(attributes, ATTR_GEN_AI_USAGE_OUTPUT_TOKENS, usage.outputTokens);
  setDefined(attributes, "pipr.usage.cache_read_tokens", usage.cacheReadTokens);
  setDefined(attributes, "pipr.usage.cache_write_tokens", usage.cacheWriteTokens);
  setDefined(attributes, "pipr.usage.cost_usd", usage.costUsd);
  return attributes;
}

function observeTurnEnd(
  event: Extract<RunAgentEvent, { kind: "turn-end" }>,
  context: AttemptEventContext,
): void {
  const key = modelSpanKey(context.suffix);
  // A turn that began before this attempt observed the conversation, as on resume, still records its end.
  context.record.turns += 1;
  const attributes: RunSpanRecord["attributes"] = {
    ...(event.usage ? usageAttributes(event.usage) : {}),
    "pipr.turn.entry_kinds": event.entryKinds.join(",").slice(0, 2000),
  };
  setDefined(attributes, ATTR_GEN_AI_RESPONSE_MODEL, event.model);
  setDefined(attributes, "pipr.turn.stop_reason", event.stopReason);
  if (event.model) addModelUsage(context.record, event.model, event.usage);
  if (!context.hasOpenSpan(key)) {
    context.openSpan(key, "gen_ai.chat", "model", {
      ...agentSpanAttributes(context.attempt, context.suffix, "chat"),
      "pipr.turn.index": context.record.turns,
    });
  }
  context.closeSpan(key, event.stopReason === "error" ? "error" : "ok", undefined, attributes);
}

function addModelUsage(
  record: AttemptRecord,
  model: string,
  usage: RunAgentUsage | undefined,
): void {
  const total = record.models.get(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    turns: 0,
  };
  total.turns += 1;
  if (usage) {
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.cacheReadTokens += usage.cacheReadTokens;
    total.cacheWriteTokens += usage.cacheWriteTokens;
    total.costUsd += usage.costUsd;
  }
  record.models.set(model, total);
}

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
