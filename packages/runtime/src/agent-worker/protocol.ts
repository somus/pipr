import { Buffer } from "node:buffer";
import { modelThinkingLevels } from "@usepipr/sdk";
import { providerModelOptionsSchema } from "@usepipr/sdk/internal";
import { z } from "zod";

export const agentWorkerProtocolVersion = 1;
const maxAgentWorkerMessageBytes = 32 * 1024 * 1024;
export const agentWorkspaceToolNames = ["read", "grep", "find", "ls"] as const;
export type AgentWorkspaceToolName = (typeof agentWorkspaceToolNames)[number];

const idSchema = z.string().min(1).max(512);
const toolNameSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const tokenCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** An OpenAI-compatible endpoint, such as an LLM gateway, that serves a model under a custom provider id. */
export const customModelEndpointSchema = z.strictObject({
  api: z.literal("openai-completions"),
  baseUrl: z.url({ protocol: /^https?$/ }),
  /** Metadata the provider declares for the model, over the catalog defaults the worker resolves. */
  metadata: providerModelOptionsSchema.optional(),
});

const agentWorkerModelSchema = z.strictObject({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  thinking: z.enum(modelThinkingLevels),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/)
    .optional(),
  /** Present for a model of a custom provider; the worker registers the provider before running. */
  endpoint: customModelEndpointSchema.optional(),
});

const agentWorkerToolSpecSchema = z.strictObject({
  name: toolNameSchema,
  description: z.string().max(4096),
  parameters: z.record(z.string(), z.unknown()),
});

const agentRunConversationSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("new") }),
  z.strictObject({ kind: z.literal("continue"), conversationId: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("fork"), parentKey: idSchema, parentPrompt: z.string() }),
]);

export const agentRunRequestSchema = z.strictObject({
  requestId: idSchema,
  conversation: agentRunConversationSchema,
  model: agentWorkerModelSchema,
  systemPrompt: z.string(),
  prompt: z.string(),
  cwd: z.string().min(1),
  tools: z.strictObject({
    workspace: z.array(z.enum(agentWorkspaceToolNames)),
    runtimeDataPath: z.string().min(1).optional(),
    bridged: z.array(agentWorkerToolSpecSchema),
  }),
  timeoutMs: z.number().int().positive().optional(),
});

const agentRunUsageSchema = z.strictObject({
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  costUsd: z.number().nonnegative(),
});

const agentRunOutcomeSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("done"),
    conversationId: z.number().int().positive(),
    text: z.string(),
    models: z.array(z.string().min(1)),
    usage: agentRunUsageSchema,
  }),
  z.strictObject({
    status: z.literal("failed"),
    conversationId: z.number().int().positive().optional(),
    reason: z.enum(["timeout", "model_error", "aborted", "invalid_request", "internal"]),
    error: z.string(),
    models: z.array(z.string().min(1)),
    usage: agentRunUsageSchema.optional(),
  }),
]);

const agentWorkerEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("first_response") }),
  z.strictObject({
    type: z.literal("tool_execution_start"),
    toolCallId: idSchema,
    toolName: z.string().min(1),
    args: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("tool_execution_end"),
    toolCallId: idSchema,
    toolName: z.string().min(1),
    isError: z.boolean(),
    result: z.strictObject({
      details: z.unknown().optional(),
      contentBytes: tokenCountSchema,
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    }),
  }),
  z.strictObject({
    type: z.literal("auto_retry_start"),
    delayMs: z.number().nonnegative().optional(),
  }),
  z.strictObject({ type: z.literal("auto_retry_end") }),
  z.strictObject({ type: z.literal("compaction_start") }),
  z.strictObject({ type: z.literal("compaction_end") }),
]);

const toolCallResultSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: z.unknown() }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);

export const supervisorMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("run"), runId: idSchema, request: agentRunRequestSchema }),
  z.strictObject({
    type: z.literal("tool-result"),
    runId: idSchema,
    callId: idSchema,
    result: toolCallResultSchema,
  }),
  z.strictObject({ type: z.literal("cancel"), runId: idSchema }),
  z.strictObject({ type: z.literal("shutdown") }),
]);

export const workerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), protocol: z.literal(agentWorkerProtocolVersion) }),
  z.strictObject({ type: z.literal("event"), runId: idSchema, event: agentWorkerEventSchema }),
  z.strictObject({
    type: z.literal("tool-call"),
    runId: idSchema,
    callId: idSchema,
    tool: toolNameSchema,
    args: z.unknown(),
  }),
  z.strictObject({ type: z.literal("result"), runId: idSchema, outcome: agentRunOutcomeSchema }),
  z.strictObject({ type: z.literal("fatal"), error: z.string() }),
]);

export type AgentRunRequest = z.infer<typeof agentRunRequestSchema>;
export type CustomModelEndpoint = z.infer<typeof customModelEndpointSchema>;
export type AgentRunUsage = z.infer<typeof agentRunUsageSchema>;
export type AgentRunOutcome = z.infer<typeof agentRunOutcomeSchema>;
export type AgentWorkerEvent = z.infer<typeof agentWorkerEventSchema>;
export type AgentWorkerToolSpec = z.infer<typeof agentWorkerToolSpecSchema>;
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;
export type SupervisorMessage = z.infer<typeof supervisorMessageSchema>;
export type WorkerMessage = z.infer<typeof workerMessageSchema>;

export function encodeAgentWorkerMessage(message: SupervisorMessage | WorkerMessage): string {
  const line = JSON.stringify(message);
  if (Buffer.byteLength(line, "utf8") > maxAgentWorkerMessageBytes) {
    throw new Error(`agent worker ${message.type} message exceeded the size limit`);
  }
  return `${line}\n`;
}

/**
 * Splits a byte stream into newline-delimited JSON messages validated by `schema`. A line over the size limit or a
 * message that fails validation is reported through `onError` and ends decoding.
 */
export function createAgentWorkerLineDecoder<T>(
  schema: z.ZodType<T>,
  handlers: { onMessage(message: T): void; onError(error: Error): void },
): { push(chunk: string): void } {
  let pending = "";
  let failed = false;
  const fail = (error: Error) => {
    failed = true;
    pending = "";
    handlers.onError(error);
  };
  return {
    push(chunk) {
      if (failed) return;
      pending += chunk;
      let newline = pending.indexOf("\n");
      while (newline !== -1 && !failed) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) decodeLine(line);
        newline = pending.indexOf("\n");
      }
      if (!failed && Buffer.byteLength(pending, "utf8") > maxAgentWorkerMessageBytes) {
        fail(new Error("agent worker message exceeded the size limit"));
      }
    },
  };

  function decodeLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail(new Error("agent worker sent malformed JSON"));
      return;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      fail(new Error(`agent worker message failed validation: ${parsed.error.message}`));
      return;
    }
    handlers.onMessage(parsed.data);
  }
}
