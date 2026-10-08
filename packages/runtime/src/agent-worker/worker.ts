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
import { captureConversation } from "./conversation-capture.js";
import { type AgentWorkerCredentials, createAgentWorkerCredentials } from "./credentials.js";
import { type CustomProviderModel, createCustomProviders } from "./custom-providers.js";
import {
  type AgentRunConversationRecord,
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
  /**
   * Abort unfinished work instead of resuming it. A replacement for a worker that crashed or hung must not resume the
   * run that killed its predecessor; each abandoned request counts as failed, so repeating it calls the model afresh.
   */
  abandonUnfinished?: boolean;
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

/** Custom provider models the worker served, keyed by provider and model, so a restarted worker can resume them. */
const CustomModelsDoc = defineDoc<{ models: Record<string, CustomProviderModel> }>({
  kind: "pipr.custom-models",
  version: 1,
  scope: "session",
  initial: () => ({ models: {} }),
});

const decoder = new TextDecoder();

export async function runAgentWorker(options: AgentWorkerOptions): Promise<void> {
  const context = BACKGROUND_CONTEXT;
  const send = (message: WorkerMessage) => options.write(encodeAgentWorkerMessage(message));
  const credentials = createAgentWorkerCredentials(options.authFile);
  const models = builtinModels({ credentials });
  for (const provider of options.providers ?? []) {
    models.setProvider(provider);
  }
  const customProviders = createCustomProviders(models);
  const registry = createRegistry();
  const storage: Storage = options.storePath
    ? await openBunSqliteStorage(options.storePath)
    : new MemoryStorage();
  const harness = await Harness.open(storage, { models, registry }, context);
  const runs = new Map<string, ActiveRun>();
  const pendingToolCalls = new Map<string, (result: ToolCallResult) => void>();
  const worker: WorkerState = {
    harness,
    registry,
    credentials,
    customProviders,
    env: options.env,
    send,
    pendingToolCalls,
  };
  // Unfinished work may use a custom provider; it must be registered before the harness resumes that work.
  await restoreCustomModels(worker, context);
  if (options.abandonUnfinished) {
    await abandonUnfinishedWork(harness, context);
  }
  harness.resume();

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
  customProviders: ReturnType<typeof createCustomProviders>;
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
      outcome: failedOutcome("invalid_request", `run '${message.runId}' is already active`),
    });
    return;
  }
  const run = startRun(worker, message.runId, message.request);
  runs.set(message.runId, run);
  void run.done.finally(() => runs.delete(message.runId));
}

type Cancellation = {
  reason?: "aborted" | "timeout";
  conversation?: Conversation;
  /** Context of the submission; cancelled when a second cancel finds the run still waiting. */
  context: Context;
};

function startRun(worker: WorkerState, runId: string, request: AgentRunRequest): ActiveRun {
  const waiting = withCancel(BACKGROUND_CONTEXT);
  const cancellation: Cancellation = { context: waiting.context };
  // The first cancel aborts the conversation; a repeated cancel, such as the supervisor's backstop after the worker's
  // own timeout, also stops waiting so the run settles even when the provider ignores the abort.
  const cancel = (reason: "aborted" | "timeout") => {
    const repeated = cancellation.reason !== undefined;
    cancellation.reason ??= reason;
    void cancellation.conversation?.abort(BACKGROUND_CONTEXT).catch(() => undefined);
    if (repeated) waiting.cancel(new Error(cancellationMessage(cancellation.reason, request)));
  };
  const timer =
    request.timeoutMs === undefined
      ? undefined
      : setTimeout(() => cancel("timeout"), request.timeoutMs);
  const done = executeRun(worker, runId, request, cancellation)
    .catch((error: unknown) =>
      failedOutcome("internal", error instanceof Error ? error.message : String(error)),
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
  cancellation: Cancellation,
): Promise<AgentRunOutcome> {
  const context = BACKGROUND_CONTEXT;
  const modelFailure = await prepareModel(worker, request, context);
  if (modelFailure) {
    return failedOutcome("invalid_request", modelFailure);
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
  const observed: ObservedRun = { models: new Set<string>(), firstResponse: false };
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
      return failedOutcome("invalid_request", "conversation to continue does not exist");
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
      return failedOutcome(cancellation.reason, cancellationMessage(cancellation.reason, request));
    }
    let settled: SettledSubmissionRecord;
    try {
      const submission = await conversation.submit(
        { type: "input", content: request.prompt, requestId: submissionRequestId },
        cancellation.context,
      );
      // A cancel that arrived while submitting found no running work to abort.
      if (cancellation.reason) await conversation.abort(context).catch(() => undefined);
      settled = await submission.wait(cancellation.context);
    } catch (error) {
      if (!cancellation.reason) throw error;
      await recordFailure(worker.harness, request.requestId, context);
      return {
        ...failedOutcome(cancellation.reason, cancellationMessage(cancellation.reason, request)),
        conversationId: conversation.id,
        ...(await requestedConversation(conversation, request)),
      };
    }
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

/** Makes the request's model runnable: registers its custom provider and applies its API key. */
async function prepareModel(
  worker: WorkerState,
  request: AgentRunRequest,
  context: Context,
): Promise<string | undefined> {
  return (await registerCustomModel(worker, request, context)) ?? applyApiKey(worker, request);
}

/** Records and registers the custom provider of a request's model; built-in models need neither. */
async function registerCustomModel(
  worker: WorkerState,
  request: AgentRunRequest,
  context: Context,
): Promise<string | undefined> {
  const { provider, modelId, apiKeyEnv, endpoint } = request.model;
  if (!endpoint) return undefined;
  const entry: CustomProviderModel = {
    providerId: provider,
    modelId,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    endpoint,
  };
  const failure = worker.customProviders.register(entry);
  if (failure) return failure;
  const key = customModelKey(entry);
  await worker.harness.commit(async (tx) => {
    const recorded = await tx.doc(CustomModelsDoc);
    if (JSON.stringify(recorded.models[key]) !== JSON.stringify(entry))
      recorded.models[key] = entry;
  }, context);
  return undefined;
}

async function restoreCustomModels(worker: WorkerState, context: Context): Promise<void> {
  const recorded = await worker.harness.commit(
    async (tx) =>
      Object.values((await tx.doc(CustomModelsDoc)).models).map(
        (entry) => JSON.parse(JSON.stringify(entry)) as CustomProviderModel,
      ),
    context,
  );
  for (const entry of recorded) {
    worker.customProviders.register(entry);
    const key = entry.apiKeyEnv ? worker.env[entry.apiKeyEnv] : undefined;
    if (key) worker.credentials.setApiKey(entry.providerId, key);
  }
}

function customModelKey(entry: CustomProviderModel): string {
  return JSON.stringify([entry.providerId, entry.modelId]);
}

async function abandonUnfinishedWork(harness: Harness, context: Context): Promise<void> {
  const { submissions } = await harness.inspect(context);
  for (const submission of submissions) {
    const conversation = await harness.conversation(submission.conversationId, context);
    await conversation?.abort(context);
    if (submission.requestId) {
      await recordFailure(harness, submission.requestId.replace(/#\d+$/, ""), context);
    }
  }
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
}): Promise<AgentRunOutcome> {
  const { settled, conversation } = options;
  // Read at settle time from the store, so a resumed or answered-again request includes every committed entry.
  const record = await requestedConversation(conversation, options.request);
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
      ...record,
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
    ...record,
  };
}

/** The conversation when the request captures it; capture failures leave it out. */
async function requestedConversation(
  conversation: Conversation,
  request: AgentRunRequest,
): Promise<{ conversation?: AgentRunConversationRecord }> {
  if (!request.captureConversation) return {};
  const record = await captureConversation(conversation);
  return record ? { conversation: record } : {};
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

type ObservedRun = {
  models: Set<string>;
  firstResponse: boolean;
  /** The open model turn: kinds of the entries it committed and its answer. */
  turn?: { entryKinds: string[]; answer?: AssistantMessage };
};

function forwardEvents(
  events: readonly AgentEvent[],
  observed: ObservedRun,
  emit: (event: AgentWorkerEvent) => void,
): void {
  for (const event of events) {
    if (!observed.firstResponse && isAssistantProgress(event)) {
      observed.firstResponse = true;
      emit({ type: "first_response" });
    }
    observeEntry(event, observed);
    const forwarded = turnEvent(event, observed) ?? forwardedEvent(event);
    if (forwarded) emit(forwarded);
  }
}

/** Records the answering models and the open turn's entries from committed entries. */
function observeEntry(event: AgentEvent, observed: ObservedRun): void {
  if (event.type !== "message_end" && event.type !== "entry_appended") return;
  const message = event.entry.model?.[0];
  if (event.entry.kind === "pi.assistant" && message?.role === "assistant") {
    observeModel(observed.models, message);
  }
  observeTurnEntry(observed, event.entry);
}

function turnEvent(event: AgentEvent, observed: ObservedRun): AgentWorkerEvent | undefined {
  if (event.type === "turn_start") {
    observed.turn = { entryKinds: [] };
    return { type: "turn_start" };
  }
  return event.type === "turn_end" ? turnEndEvent(observed) : undefined;
}

/** Tracks entries committed during a turn; a turn end carries its model, usage, and stop reason, never content. */
function observeTurnEntry(observed: ObservedRun, entry: EntryRecord): void {
  if (!observed.turn) return;
  observed.turn.entryKinds.push(entry.kind);
  const message = entry.model?.[0];
  if (entry.kind === "pi.assistant" && message?.role === "assistant") {
    observed.turn.answer = message;
  }
}

function turnEndEvent(observed: ObservedRun): AgentWorkerEvent {
  const turn = observed.turn ?? { entryKinds: [] };
  observed.turn = undefined;
  const answer = turn.answer;
  const model = answer ? (answer.responseModel || answer.model)?.trim() : undefined;
  return {
    type: "turn_end",
    ...(model ? { model: model.slice(0, 200) } : {}),
    ...(answer?.stopReason ? { stopReason: answer.stopReason } : {}),
    ...(answer?.usage ? { usage: usageTotals({ models: { turn: answer.usage } }) } : {}),
    entryKinds: turn.entryKinds.slice(0, 1000),
  };
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

function forwardedEvent(event: AgentEvent): AgentWorkerEvent | undefined {
  switch (event.type) {
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

function usageTotals(state: Pick<UsageState, "models"> | undefined): AgentRunUsage {
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
): AgentRunOutcome {
  return { status: "failed", reason, error, models: [] };
}
