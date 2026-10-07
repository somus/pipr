import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, withCancel } from "@earendil-works/chord/context";
import type { AssistantMessage, Provider, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type AgentEvent,
  type Conversation,
  type ConversationId,
  createRegistry,
  defineDoc,
  defineExtension,
  type EntryId,
  type EntryRecord,
  Harness,
  MemoryStorage,
  type SettledSubmissionRecord,
  type Storage,
  section,
  UsageDoc,
  type UsageState,
  UserEntry,
  watchEvents,
} from "@earendil-works/pi-durable";
import { openBunSqliteStorage } from "./bun-sqlite.js";
import { AgentWorkerCredentials } from "./credentials.js";
import {
  type AgentRunOutcome,
  type AgentRunRequest,
  type AgentRunUsage,
  type AgentWorkerEvent,
  agentWorkerProtocolVersion,
  createAgentWorkerLineDecoder,
  encodeAgentWorkerMessage,
  type SupervisorMessage,
  supervisorMessageSchema,
  type ToolCallResult,
  type WorkerMessage,
} from "./protocol.js";
import { createRunTools } from "./run-tools.js";

export type AgentWorkerOptions = {
  input: AsyncIterable<string | Uint8Array>;
  write(line: string): void;
  env: NodeJS.ProcessEnv;
  /** SQLite store file; an in-memory store when absent. */
  storePath?: string;
  /** Pi `auth.json` with subscription logins, for local runs without an API key. */
  authFile?: string;
  /** Providers that replace built-in providers with the same id. */
  providers?: readonly Provider[];
};

type RequestsState = {
  conversations: Record<string, number>;
  parents: Record<string, { conversationId: number; entryId: number }>;
  /** Unanswered submissions per request id; a repeated request after a failure submits under a fresh id. */
  failures: Record<string, number>;
};

/**
 * Maps request ids to their conversations, so a restarted worker finds the work it already admitted. A repeated
 * request resumes in-flight work or returns a recorded answer, but never replays a recorded failure.
 */
const RequestsDoc = defineDoc<RequestsState>({
  kind: "pipr.requests",
  version: 1,
  scope: "session",
  initial: () => ({ conversations: {}, parents: {}, failures: {} }),
});

const decoder = new TextDecoder();

export async function runAgentWorker(options: AgentWorkerOptions): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const send = (message: WorkerMessage) => options.write(encodeAgentWorkerMessage(message));
  const credentials = new AgentWorkerCredentials(options.authFile);
  const models = builtinModels({ credentials });
  for (const provider of options.providers ?? []) {
    models.setProvider(provider);
  }
  const registry = createRegistry();
  const storage: Storage = options.storePath
    ? await openBunSqliteStorage(options.storePath)
    : new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  harness.resume();

  const runs = new Map<string, ActiveRun>();
  const pendingToolCalls = new Map<string, (result: ToolCallResult) => void>();
  const worker: WorkerState = {
    harness,
    registry,
    credentials,
    env: options.env,
    send,
    pendingToolCalls,
  };
  let shuttingDown = false;
  const lines = createAgentWorkerLineDecoder(supervisorMessageSchema, {
    onMessage: (message) => {
      if (message.type === "shutdown") {
        shuttingDown = true;
        return;
      }
      handleMessage(worker, runs, message);
    },
    onError: (error) => {
      send({ type: "fatal", error: error.message });
      shuttingDown = true;
    },
  });

  send({ type: "ready", protocol: agentWorkerProtocolVersion });
  for await (const chunk of options.input) {
    lines.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true }));
    if (shuttingDown) break;
  }
  for (const run of runs.values()) {
    run.cancel("aborted");
  }
  await Promise.allSettled([...runs.values()].map((run) => run.done));
  await harness.close(context);
}

type WorkerState = {
  harness: Harness;
  registry: ReturnType<typeof createRegistry>;
  credentials: AgentWorkerCredentials;
  env: NodeJS.ProcessEnv;
  send(message: WorkerMessage): void;
  pendingToolCalls: Map<string, (result: ToolCallResult) => void>;
};

type ActiveRun = {
  cancel(reason: "aborted" | "timeout"): void;
  done: Promise<void>;
};

function handleMessage(
  worker: WorkerState,
  runs: Map<string, ActiveRun>,
  message: Exclude<SupervisorMessage, { type: "shutdown" }>,
): void {
  if (message.type === "tool-result") {
    const key = toolCallKey(message.runId, message.callId);
    worker.pendingToolCalls.get(key)?.(message.result);
    worker.pendingToolCalls.delete(key);
    return;
  }
  if (message.type === "cancel") {
    runs.get(message.runId)?.cancel("aborted");
    return;
  }
  if (runs.has(message.runId)) {
    worker.send({
      type: "result",
      runId: message.runId,
      outcome: failedOutcome(
        "invalid_request",
        `run '${message.runId}' is already active`,
        Date.now(),
      ),
    });
    return;
  }
  const run = startRun(worker, message.runId, message.request);
  runs.set(message.runId, run);
  void run.done.finally(() => runs.delete(message.runId));
}

function startRun(worker: WorkerState, runId: string, request: AgentRunRequest): ActiveRun {
  const started = Date.now();
  const cancellation: { reason?: "aborted" | "timeout"; conversation?: Conversation } = {};
  const cancel = (reason: "aborted" | "timeout") => {
    if (cancellation.reason) return;
    cancellation.reason = reason;
    void cancellation.conversation?.abort(BACKGROUND_CONTEXT).catch(() => undefined);
  };
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => cancel("timeout"), request.timeoutMs);
  const done = executeRun(worker, runId, request, cancellation, started)
    .catch((error: unknown) =>
      failedOutcome("internal", error instanceof Error ? error.message : String(error), started),
    )
    .then((outcome) => {
      clearTimeout(timer);
      worker.send({ type: "result", runId, outcome });
    });
  return { cancel, done };
}

async function executeRun(
  worker: WorkerState,
  runId: string,
  request: AgentRunRequest,
  cancellation: { reason?: "aborted" | "timeout"; conversation?: Conversation },
  started: number,
): Promise<AgentRunOutcome> {
  const context = BACKGROUND_CONTEXT;
  const apiKeyFailure = applyApiKey(worker, request);
  if (apiKeyFailure) {
    return failedOutcome("invalid_request", apiKeyFailure, started);
  }
  const tools = await createRunTools(request, (call, signal) =>
    callBridgedTool(worker, runId, call, signal),
  );
  const extension = defineExtension({
    name: `pipr.run.${createHash("sha256").update(runId).digest("hex").slice(0, 24)}`,
    tools,
    sections: [section("pipr", () => request.systemPrompt, { tag: false })],
  });
  worker.registry.install(extension);
  const observed = { models: new Set<string>(), firstResponse: false };
  let stopEvents: (() => Promise<unknown>) | undefined;
  try {
    const submissionRequestId = await currentRequestId(worker.harness, request.requestId, context);
    const conversation = await openConversation(
      worker.harness,
      request,
      submissionRequestId,
      context,
    );
    if (!conversation) {
      return failedOutcome("invalid_request", "conversation to continue does not exist", started);
    }
    cancellation.conversation = conversation;
    await conversation.configure(
      {
        model: { provider: request.model.provider, modelId: request.model.modelId },
        thinkingLevel: request.model.thinking,
        extensions: [extension],
        tools: null,
        cwd: request.cwd,
      },
      context,
    );
    const usageBefore = await conversationUsage(worker.harness, conversation.id, context);
    const events = await watchEvents(worker.harness, conversation.id, context);
    events.start(async (batch) => {
      forwardEvents(batch, observed, (event) => worker.send({ type: "event", runId, event }));
    });
    stopEvents = () => events.stop();
    if (cancellation.reason) {
      return failedOutcome(
        cancellation.reason,
        cancellationMessage(cancellation.reason, request),
        started,
      );
    }
    const { context: runContext } = withCancel(context);
    const submission = await conversation.submit(
      { type: "input", content: request.prompt, requestId: submissionRequestId },
      runContext,
    );
    const settled = await submission.wait(runContext);
    if (settled.status !== "done" || settled.answer === undefined) {
      await recordFailure(worker.harness, request.requestId, context);
    }
    const usage = usageDelta(
      usageBefore,
      await conversationUsage(worker.harness, conversation.id, context),
    );
    return await settledOutcome({
      conversation,
      settled,
      usage,
      observed,
      cancellation,
      request,
      started,
    });
  } finally {
    await stopEvents?.().catch(() => undefined);
    worker.registry.uninstall(extension);
  }
}

function applyApiKey(worker: WorkerState, request: AgentRunRequest): string | undefined {
  const apiKeyEnv = request.model.apiKeyEnv;
  if (!apiKeyEnv) return undefined;
  const key = worker.env[apiKeyEnv];
  if (!key) {
    return `Missing provider env var for model '${request.model.provider}/${request.model.modelId}': ${apiKeyEnv}`;
  }
  worker.credentials.setApiKey(request.model.provider, key);
  return undefined;
}

async function currentRequestId(
  harness: Harness,
  requestId: string,
  context: Context,
): Promise<string> {
  const failures = await harness.commit(
    async (tx) => (await tx.doc(RequestsDoc)).failures[requestId] ?? 0,
    context,
  );
  return failures === 0 ? requestId : `${requestId}#${failures}`;
}

async function recordFailure(harness: Harness, requestId: string, context: Context): Promise<void> {
  await harness.commit(async (tx) => {
    const requests = await tx.doc(RequestsDoc);
    requests.failures[requestId] = (requests.failures[requestId] ?? 0) + 1;
  }, context);
}

async function openConversation(
  harness: Harness,
  request: AgentRunRequest,
  requestId: string,
  context: Context,
): Promise<Conversation | undefined> {
  const target = request.conversation;
  if (target.kind === "continue") {
    return await harness.conversation(target.conversationId as ConversationId, context);
  }
  const parent = target.kind === "fork" ? await forkParent(harness, target, context) : undefined;
  const conversationId = await harness.commit(async (tx) => {
    const requests = await tx.doc(RequestsDoc);
    const existing = requests.conversations[requestId];
    if (existing !== undefined) return existing;
    const created = parent
      ? await tx.forkConversation(
          parent.conversationId as ConversationId,
          parent.entryId as EntryId,
          {
            ownership: { kind: "ownerless" },
          },
        )
      : await tx.createConversation({ ownership: { kind: "ownerless" } });
    requests.conversations[requestId] = created.id;
    return created.id as number;
  }, context);
  return await harness.conversation(conversationId as ConversationId, context);
}

/** The ownerless conversation holding a fork group's shared prefix, created once per parent key. */
async function forkParent(
  harness: Harness,
  target: Extract<AgentRunRequest["conversation"], { kind: "fork" }>,
  context: Context,
): Promise<RequestsState["parents"][string]> {
  return await harness.commit(async (tx) => {
    const requests = await tx.doc(RequestsDoc);
    const existing = requests.parents[target.parentKey];
    if (existing) return { ...existing };
    const parent = await tx.createConversation({ ownership: { kind: "ownerless" } });
    const entry = await tx.appendEntry(UserEntry, parent.id, {
      model: [{ role: "user", content: target.parentPrompt, timestamp: Date.now() }],
    });
    const created = { conversationId: parent.id as number, entryId: entry.id as number };
    requests.parents[target.parentKey] = created;
    return created;
  }, context);
}

async function settledOutcome(options: {
  conversation: Conversation;
  settled: SettledSubmissionRecord;
  usage: AgentRunUsage;
  observed: { models: Set<string> };
  cancellation: { reason?: "aborted" | "timeout" };
  request: AgentRunRequest;
  started: number;
}): Promise<AgentRunOutcome> {
  const { settled, conversation } = options;
  const durationMs = Date.now() - options.started;
  if (settled.status === "done" && settled.answer !== undefined) {
    const answer = await findEntry(conversation, settled.answer);
    const message = answer?.model?.[0] as AssistantMessage | undefined;
    if (message) observeModel(options.observed.models, message);
    return {
      status: "done",
      conversationId: conversation.id,
      text: message ? assistantText(message) : "",
      models: [...options.observed.models],
      usage: options.usage,
      durationMs,
    };
  }
  const reason =
    options.cancellation.reason ?? (settled.reason === "model_error" ? "model_error" : "aborted");
  return {
    status: "failed",
    conversationId: conversation.id,
    reason,
    error: options.cancellation.reason
      ? cancellationMessage(options.cancellation.reason, options.request)
      : unansweredMessage(settled),
    models: [...options.observed.models],
    usage: options.usage,
    durationMs,
  };
}

async function findEntry(
  conversation: Conversation,
  id: EntryId,
): Promise<EntryRecord | undefined> {
  const result = await conversation.entries(
    { minEntryId: id, maxEntryId: id },
    1,
    undefined,
    BACKGROUND_CONTEXT,
  );
  return result.items.find((entry) => entry.id === id);
}

function observeModel(models: Set<string>, message: AssistantMessage): void {
  const model = (message.responseModel || message.model)?.trim();
  if (model) models.add(model);
}

function forwardEvents(
  events: readonly AgentEvent[],
  observed: { models: Set<string>; firstResponse: boolean },
  emit: (event: AgentWorkerEvent) => void,
): void {
  for (const event of events) {
    if (!observed.firstResponse && isAssistantProgress(event)) {
      observed.firstResponse = true;
      emit({ type: "first_response" });
    }
    const forwarded = forwardedEvent(event, observed);
    if (forwarded) emit(forwarded);
  }
}

function isAssistantProgress(event: AgentEvent): boolean {
  return (
    event.type === "message_update" ||
    (event.type === "message_start" && event.message.role === "assistant") ||
    (event.type === "message_end" && event.entry.kind === "pi.assistant")
  );
}

/** Harness events forwarded without payload. */
const markerEvents: Partial<Record<AgentEvent["type"], AgentWorkerEvent>> = {
  auto_retry_end: { type: "auto_retry_end" },
  compaction_start: { type: "compaction_start" },
  compaction_end: { type: "compaction_end" },
};

function forwardedEvent(
  event: AgentEvent,
  observed: { models: Set<string> },
): AgentWorkerEvent | undefined {
  switch (event.type) {
    case "message_end": {
      const message = event.entry.model?.[0] as AssistantMessage | undefined;
      if (event.entry.kind === "pi.assistant" && message) {
        observeModel(observed.models, message);
      }
      return undefined;
    }
    case "tool_execution_start":
      return {
        type: "tool_execution_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      };
    case "tool_execution_end":
      return toolEndEvent(event);
    case "auto_retry_start":
      return { type: "auto_retry_start", delayMs: Math.max(0, event.at - Date.now()) };
    default:
      return markerEvents[event.type];
  }
}

function toolEndEvent(
  event: Extract<AgentEvent, { type: "tool_execution_end" }>,
): AgentWorkerEvent {
  const message = event.entry?.model?.[0] as ToolResultMessage | undefined;
  const content = Buffer.from(JSON.stringify(message?.content ?? []), "utf8");
  return {
    type: "tool_execution_end",
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    isError: message === undefined || message.isError === true,
    result: {
      ...(message?.details !== undefined ? { details: message.details } : {}),
      contentBytes: content.byteLength,
      contentHash: createHash("sha256").update(content).digest("hex"),
    },
  };
}

/** Waits for the supervisor's result; an aborted call settles as a tool error so the run can end. */
function callBridgedTool(
  worker: WorkerState,
  runId: string,
  call: { callId: string; tool: string; args: unknown },
  signal: AbortSignal | undefined,
): Promise<ToolCallResult> {
  return new Promise((resolve) => {
    const key = toolCallKey(runId, call.callId);
    if (signal?.aborted) {
      resolve({ ok: false, error: `Tool '${call.tool}' was cancelled` });
      return;
    }
    const onAbort = () => {
      worker.pendingToolCalls.delete(key);
      resolve({ ok: false, error: `Tool '${call.tool}' was cancelled` });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.pendingToolCalls.set(key, (result) => {
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    });
    worker.send({
      type: "tool-call",
      runId,
      callId: call.callId,
      tool: call.tool,
      args: call.args,
    });
  });
}

function toolCallKey(runId: string, callId: string): string {
  return `${runId}\u0000${callId}`;
}

async function conversationUsage(
  harness: Harness,
  conversationId: ConversationId,
  context: Context,
): Promise<AgentRunUsage> {
  return usageTotals(await harness.snapshot(UsageDoc, conversationId, context));
}

function usageTotals(state: Readonly<UsageState> | undefined): AgentRunUsage {
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  for (const usage of Object.values(state?.models ?? {}) as Usage[]) {
    totals.inputTokens += usage.input;
    totals.outputTokens += usage.output;
    totals.cacheReadTokens += usage.cacheRead;
    totals.cacheWriteTokens += usage.cacheWrite;
    totals.costUsd += usage.cost.total;
  }
  return totals;
}

function usageDelta(before: AgentRunUsage, after: AgentRunUsage): AgentRunUsage {
  return {
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    cacheWriteTokens: Math.max(0, after.cacheWriteTokens - before.cacheWriteTokens),
    costUsd: Math.max(0, after.costUsd - before.costUsd),
  };
}

function assistantText(message: AssistantMessage): string {
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

function unansweredMessage(settled: SettledSubmissionRecord): string {
  const detail = "detail" in settled ? settled.detail : undefined;
  const reason = "reason" in settled ? settled.reason : "unanswered";
  return typeof detail === "string" && detail ? detail : String(reason);
}

function cancellationMessage(reason: "aborted" | "timeout", request: AgentRunRequest): string {
  return reason === "timeout"
    ? `Pi timed out after ${Math.round((request.timeoutMs ?? 0) / 1000)}s`
    : "agent run was cancelled";
}

function failedOutcome(
  reason: Extract<AgentRunOutcome, { status: "failed" }>["reason"],
  error: string,
  started: number,
): AgentRunOutcome {
  return { status: "failed", reason, error, models: [], durationMs: Date.now() - started };
}
