import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isPlainObject } from "lodash-es";
import { z } from "zod";
import type { RunAgentEvent } from "../observability/types.js";
import type { DiffContextCoverageTracker } from "./diff-context-coverage.js";
import type { PiRunResult, PiRunStreamStats, PiRunUsage, PiStreamLimits } from "./types.js";

const typedEventSchema = z.looseObject({ type: z.string() });
const piJsonEventTypes = new Set([
  "agent_start",
  "agent_end",
  "auto_retry_start",
  "auto_retry_end",
  "compaction_start",
  "compaction_end",
  "message_start",
  "message_update",
  "message_end",
  "queue_update",
  "session",
  "session_info_changed",
  "thinking_level_changed",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "turn_start",
  "turn_end",
]);
const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const assistantMessageEventSchema = z.looseObject({
  type: z.literal("message_end"),
  message: z.looseObject({
    role: z.literal("assistant"),
    model: z.string().min(1).optional(),
    responseModel: z.string().min(1).optional(),
  }),
});
const assistantUsageMessageSchema = z.looseObject({
  role: z.literal("assistant"),
  usage: z.looseObject({
    input: tokenCountSchema,
    output: tokenCountSchema,
    cacheRead: tokenCountSchema.optional(),
    cacheWrite: tokenCountSchema.optional(),
    cost: z.looseObject({ total: z.number().nonnegative() }),
  }),
});
const maxRetainedModelCount = 64;
const maxRetainedModelBytes = 64 * 1024;

type PiOutputMode = "undetermined" | "json" | "raw";

export class PiOutputCollector {
  private mode: PiOutputMode = "undetermined";
  private pending = "";
  private pendingBytes = 0;
  private rawOutput = "";
  private rawOutputBytes = 0;
  private failureReason: string | undefined;
  private assistantText: string | undefined;
  private readonly models: string[] = [];
  private readonly modelSet = new Set<string>();
  private modelBytes = 0;
  private assistantMessageCount = 0;
  private usageMessageCount = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private cacheUsageMessageCount = 0;
  private costUsd = 0;
  private usagePartial = false;
  private cacheUsagePartial = false;
  private readonly stream: PiRunStreamStats = {
    rawStdoutBytes: 0,
    jsonEventCount: 0,
    largestEventBytes: 0,
    peakBufferedBytes: 0,
  };

  private firstResponseObserved = false;

  constructor(
    private readonly limits: PiStreamLimits,
    private readonly eventObserver?: (event: RunAgentEvent) => void,
    private readonly diffContextCoverage?: DiffContextCoverageTracker,
  ) {}

  push(chunk: string): string | undefined {
    this.stream.rawStdoutBytes += Buffer.byteLength(chunk, "utf8");
    if (this.failureReason) {
      return this.failureReason;
    }
    let offset = 0;
    while (offset < chunk.length && !this.failureReason) {
      if (this.mode === "raw") {
        this.appendRaw(chunk.slice(offset));
        break;
      }
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      this.appendPending(chunk.slice(offset, end));
      if (newline < 0 || this.failureReason) {
        break;
      }
      this.consumePending(true);
      offset = newline + 1;
    }
    return this.failureReason;
  }

  finish(): Pick<PiRunResult, "stdout" | "models" | "usage" | "stream" | "diffContextCoverage"> {
    if (!this.failureReason && this.pending.length > 0) {
      this.consumePending(false);
    }
    const coverage = this.coverageResult();
    if (this.failureReason) {
      return { stdout: "", stream: this.stream, ...coverage };
    }
    if (this.mode !== "json") {
      return { stdout: this.rawOutput, stream: this.stream, ...coverage };
    }
    return {
      stdout: this.assistantText ?? "",
      ...(this.models.length > 0 ? { models: this.models } : {}),
      ...(this.usageMessageCount > 0 ? { usage: this.usage() } : {}),
      ...coverage,
      stream: this.stream,
    };
  }

  failure(): string | undefined {
    return this.failureReason;
  }

  private appendPending(fragment: string): void {
    const fragmentBytes = Buffer.byteLength(fragment, "utf8");
    const nextBytes = this.pendingBytes + fragmentBytes;
    const limit =
      this.mode === "json"
        ? this.limits.maxJsonEventBytes
        : Math.max(this.limits.maxJsonEventBytes, this.limits.maxRawStdoutBytes);
    if (nextBytes > limit) {
      this.fail(
        this.mode === "json"
          ? "Pi JSON event exceeded the output limit"
          : "Pi stdout exceeded the output limit",
      );
      return;
    }
    this.pending += fragment;
    this.pendingBytes = nextBytes;
    this.recordPeak(this.pendingBytes);
  }

  private consumePending(terminated: boolean): void {
    const source = `${this.pending}${terminated ? "\n" : ""}`;
    const line = this.pending.trim();
    const eventBytes = Buffer.byteLength(line, "utf8");
    this.pending = "";
    this.pendingBytes = 0;
    if (!line) {
      if (this.mode === "undetermined") {
        this.appendRaw(source);
      }
      return;
    }
    const event = parsePiEvent(line);
    if (this.mode === "undetermined") {
      if (!event || !piJsonEventTypes.has(event.type)) {
        this.mode = "raw";
        this.appendRaw(source);
        return;
      }
      this.mode = "json";
      this.rawOutput = "";
      this.rawOutputBytes = 0;
    }
    if (!event) {
      this.fail("Pi JSON output was malformed");
      return;
    }
    if (eventBytes > this.limits.maxJsonEventBytes) {
      this.fail("Pi JSON event exceeded the output limit");
      return;
    }
    this.stream.jsonEventCount += 1;
    this.stream.largestEventBytes = Math.max(this.stream.largestEventBytes, eventBytes);
    this.consumeEvent(event);
  }

  private appendRaw(value: string): void {
    const valueBytes = Buffer.byteLength(value, "utf8");
    const nextBytes = this.rawOutputBytes + valueBytes;
    if (nextBytes > this.limits.maxRawStdoutBytes) {
      this.fail("Pi raw stdout exceeded the output limit");
      return;
    }
    this.rawOutput += value;
    this.rawOutputBytes = nextBytes;
    this.recordPeak(this.rawOutputBytes);
  }

  private fail(reason: string): void {
    this.failureReason = reason;
    this.pending = "";
    this.pendingBytes = 0;
    this.rawOutput = "";
    this.rawOutputBytes = 0;
    this.assistantText = undefined;
    this.models.length = 0;
    this.modelSet.clear();
    this.modelBytes = 0;
  }

  private consumeEvent(event: Record<string, unknown>): void {
    this.diffContextCoverage?.observe(event);
    this.observeEvent(event);
    this.assistantText = assistantTextFromEvent(event) ?? this.assistantText;
    const parsed = assistantMessageEventSchema.safeParse(event);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data.message;
    this.assistantMessageCount += 1;
    const model = message.responseModel ?? message.model;
    if (model) {
      this.addModel(model);
      if (this.failureReason) {
        return;
      }
    }
    const usage = assistantUsageMessageSchema.safeParse(message);
    if (!usage.success) {
      return;
    }
    this.usageMessageCount += 1;
    this.addUsage(usage.data);
  }

  private observeEvent(event: Record<string, unknown>): void {
    try {
      if (
        !this.firstResponseObserved &&
        (event.type === "message_start" ||
          event.type === "message_update" ||
          event.type === "message_end")
      ) {
        this.firstResponseObserved = true;
        this.eventObserver?.({ kind: "first-response" });
      }
      const observed = observedPiEvent(event);
      if (observed) this.eventObserver?.(observed);
    } catch {
      // Observability must not affect Pi output collection.
    }
  }

  private addModel(model: string): void {
    if (this.modelSet.has(model)) {
      return;
    }
    const modelBytes = Buffer.byteLength(model, "utf8");
    if (
      this.modelSet.size >= maxRetainedModelCount ||
      this.modelBytes + modelBytes > maxRetainedModelBytes
    ) {
      this.fail("Pi model metadata exceeded the output limit");
      return;
    }
    this.modelSet.add(model);
    this.models.push(model);
    this.modelBytes += modelBytes;
  }

  private addUsage(message: z.infer<typeof assistantUsageMessageSchema>): void {
    const input = addSafeInteger(this.inputTokens, message.usage.input);
    const output = addSafeInteger(this.outputTokens, message.usage.output);
    const cost = addFiniteNumber(this.costUsd, message.usage.cost.total);
    this.inputTokens = input.total;
    this.outputTokens = output.total;
    this.costUsd = cost.total;
    this.usagePartial ||= !input.complete || !output.complete || !cost.complete;
    this.addCacheUsage(message.usage);
  }

  private addCacheUsage(usage: z.infer<typeof assistantUsageMessageSchema>["usage"]): void {
    const hasCacheRead = usage.cacheRead !== undefined;
    const hasCacheWrite = usage.cacheWrite !== undefined;
    if (!hasCacheRead && !hasCacheWrite) return;
    if (usage.cacheRead !== undefined) {
      const read = addSafeInteger(this.cacheReadTokens, usage.cacheRead);
      this.cacheReadTokens = read.total;
      this.cacheUsagePartial ||= !read.complete;
    }
    if (usage.cacheWrite !== undefined) {
      const write = addSafeInteger(this.cacheWriteTokens, usage.cacheWrite);
      this.cacheWriteTokens = write.total;
      this.cacheUsagePartial ||= !write.complete;
    }
    if (hasCacheRead && hasCacheWrite) {
      this.cacheUsageMessageCount += 1;
    } else {
      this.cacheUsagePartial = true;
    }
  }

  private usage(): PiRunUsage {
    return {
      status:
        this.usagePartial || this.usageMessageCount !== this.assistantMessageCount
          ? "partial"
          : "complete",
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      costUsd: this.costUsd,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      cacheUsageStatus:
        this.cacheUsageMessageCount === 0
          ? this.cacheUsagePartial
            ? "partial"
            : "unavailable"
          : this.cacheUsagePartial || this.cacheUsageMessageCount !== this.assistantMessageCount
            ? "partial"
            : "complete",
    };
  }

  private recordPeak(bytes: number): void {
    this.stream.peakBufferedBytes = Math.max(this.stream.peakBufferedBytes, bytes);
  }

  private coverageResult(): Pick<PiRunResult, "diffContextCoverage"> {
    return this.diffContextCoverage
      ? { diffContextCoverage: this.diffContextCoverage.result() }
      : {};
  }
}

function addSafeInteger(current: number, reported: number): { total: number; complete: boolean } {
  const total = current + reported;
  return Number.isSafeInteger(total)
    ? { total, complete: true }
    : { total: current, complete: false };
}

function addFiniteNumber(current: number, reported: number): { total: number; complete: boolean } {
  const total = current + reported;
  return Number.isFinite(total) ? { total, complete: true } : { total: current, complete: false };
}

function parsePiEvent(line: string): (Record<string, unknown> & { type: string }) | undefined {
  try {
    const parsed = typedEventSchema.safeParse(JSON.parse(line) as unknown);
    if (!parsed.success) {
      return undefined;
    }
    return parsed.data;
  } catch {
    return undefined;
  }
}

function observedPiEvent(event: Record<string, unknown>): RunAgentEvent | undefined {
  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    return observedToolEvent(event);
  }
  return observedLifecycleEvent(event);
}

function observedToolEvent(event: Record<string, unknown>): RunAgentEvent {
  const id = firstString(event, ["toolCallId", "tool_call_id", "id"]) ?? "unknown-tool";
  const name =
    firstString(event, ["toolName", "tool_name", "name"]) ??
    nestedToolName(event.tool) ??
    "unknown";
  return {
    kind: event.type === "tool_execution_start" ? "tool-start" : "tool-end",
    id,
    name,
    ...(event.isError === true || event.error === true ? { failed: true } : {}),
    ...contentStats(toolEventContent(event)),
  };
}

function toolEventContent(event: Record<string, unknown>): unknown {
  return event.type === "tool_execution_start"
    ? firstDefinedValue(event, ["args", "input", "arguments"])
    : firstDefinedValue(event, ["result", "output"]);
}

function firstDefinedValue(record: Record<string, unknown>, keys: readonly string[]): unknown {
  return keys.map((key) => record[key]).find((value) => value !== undefined);
}

function observedLifecycleEvent(event: Record<string, unknown>): RunAgentEvent | undefined {
  if (event.type === "auto_retry_start") {
    const delayMs = event.delayMs;
    return {
      kind: "retry-start",
      ...(typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs >= 0
        ? { delayMs }
        : {}),
    };
  }
  const events: Record<string, RunAgentEvent> = {
    auto_retry_end: { kind: "retry-end" },
    compaction_start: { kind: "compaction-start" },
    compaction_end: { kind: "compaction-end" },
  };
  return typeof event.type === "string" ? events[event.type] : undefined;
}

function contentStats(value: unknown): { contentBytes?: number; contentHash?: string } {
  if (value === undefined) return {};
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.from(serialized, "utf8");
  return {
    contentBytes: bytes.byteLength,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value.slice(0, 200);
  }
  return undefined;
}

function nestedToolName(value: unknown): string | undefined {
  return isPlainObject(value) ? firstString(value as Record<string, unknown>, ["name"]) : undefined;
}

function assistantTextFromEvent(event: Record<string, unknown>): string | undefined {
  if (event.type === "message_end" || event.type === "turn_end") {
    return assistantMessageText(event.message);
  }
  if (event.type === "agent_end") {
    return lastAssistantMessageText(event.messages);
  }
}

function lastAssistantMessageText(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) {
    return undefined;
  }
  let text: string | undefined;
  for (const message of messages) {
    text = assistantMessageText(message) ?? text;
  }
  return text;
}

function assistantMessageText(message: unknown): string | undefined {
  if (!isPlainObject(message)) {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant") {
    return undefined;
  }
  return textContent(record.content);
}

function textContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!isPlainObject(block)) {
        return "";
      }
      const record = block as Record<string, unknown>;
      return record.type === "text" && typeof record.text === "string" ? record.text : "";
    })
    .join("");
}
