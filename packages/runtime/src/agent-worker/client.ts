import { randomUUID } from "node:crypto";
import path from "node:path";
import { agentWorkerEntryPath } from "./entry-paths.js";
import {
  type AgentRunOutcome,
  type AgentRunRequest,
  type AgentWorkerEvent,
  agentRunRequestSchema,
  createAgentWorkerLineDecoder,
  encodeAgentWorkerMessage,
  type SupervisorMessage,
  type ToolCallResult,
  type WorkerMessage,
  workerMessageSchema,
} from "./protocol.js";

export type AgentRunHandlers = {
  onEvent?(event: AgentWorkerEvent): void;
  onToolCall?(call: { tool: string; args: unknown }): Promise<unknown>;
  /** Asks the worker to cancel the run; the run still settles through the worker's result. */
  signal?: AbortSignal;
};

export type AgentWorkerClient = {
  run(request: AgentRunRequest, handlers?: AgentRunHandlers): Promise<AgentRunOutcome>;
  /** Whether the worker process failed; a failed worker rejects every run and must be replaced. */
  readonly failed: boolean;
  /** Ends the worker at once, rejecting its active runs with `error`. */
  kill(error: Error): void;
  close(): Promise<void>;
};

/** Unprivileged uid/gid the worker process drops to when the supervisor runs as root. */
export type PiProcessIdentity = {
  uid: number;
  gid: number;
};

export type StartAgentWorkerOptions = {
  /** Environment of the worker process; callers pass only what the worker may see. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  store?: string;
  authFile?: string;
  providerModule?: string;
  providerConfig?: string;
  /** Start as a replacement for a failed worker: abort its unfinished work instead of resuming it. */
  abandonUnfinished?: boolean;
  processIdentity?: PiProcessIdentity;
  /** Command that starts the worker; defaults to this runtime's worker entry under the current Bun. */
  command?: readonly string[];
  readyTimeoutMs?: number;
};

const maxStderrBytes = 64 * 1024;
const shutdownGraceMs = 10_000;

type PendingRun = {
  resolve(outcome: AgentRunOutcome): void;
  reject(error: Error): void;
  handlers: AgentRunHandlers;
};

/** Starts an agent worker process and resolves once it reports the supported protocol version. */
export async function startAgentWorker(
  options: StartAgentWorkerOptions,
): Promise<AgentWorkerClient> {
  const command = [
    ...(options.command ?? (await defaultAgentWorkerCommand())),
    ...workerFlags(options),
  ];
  const argv = options.processIdentity
    ? [
        "su-exec",
        `${options.processIdentity.uid}:${options.processIdentity.gid}`,
        "env",
        `HOME=${options.env.HOME ?? ""}`,
        ...command,
      ]
    : command;
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const pending = new Map<string, PendingRun>();
  let stderr = "";
  let failure: Error | undefined;
  const ready = Promise.withResolvers<void>();

  // Any failure ends the process, so a failed worker never outlives its client.
  const fail = (error: Error) => {
    failure ??= error;
    ready.reject(failure);
    for (const run of pending.values()) run.reject(failure);
    pending.clear();
    child.kill("SIGKILL");
  };
  const send = (message: SupervisorMessage) => {
    if (failure) throw failure;
    child.stdin.write(encodeAgentWorkerMessage(message));
    child.stdin.flush();
  };
  const lines = createAgentWorkerLineDecoder(workerMessageSchema, {
    onMessage: (message) => route(message),
    onError: (error) => fail(error),
  });
  const route = (message: WorkerMessage) => {
    if (message.type === "ready") {
      ready.resolve();
      return;
    }
    if (message.type === "fatal") {
      fail(new Error(`agent worker failed: ${message.error}`));
      return;
    }
    const run = pending.get(message.runId);
    if (!run) return;
    if (message.type === "event") {
      run.handlers.onEvent?.(message.event);
    } else if (message.type === "tool-call") {
      void answerToolCall(run.handlers, message).then((result) => {
        if (failure) return;
        const reply = {
          type: "tool-result",
          runId: message.runId,
          callId: message.callId,
        } as const;
        try {
          send({ ...reply, result });
        } catch (error) {
          send({ ...reply, result: { ok: false, error: errorText(error) } });
        }
      });
    } else {
      pending.delete(message.runId);
      run.resolve(message.outcome);
    }
  };

  void pump(child.stdout, (chunk) => lines.push(chunk));
  void pump(child.stderr, (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-maxStderrBytes);
  });
  const exited = child.exited.then((code) => {
    fail(
      new Error(
        `agent worker exited with code ${code}${stderr.trim() ? `:\n${stderr.trim()}` : ""}`,
      ),
    );
    return code;
  });

  const timeout = setTimeout(
    () => fail(new Error("agent worker did not become ready")),
    options.readyTimeoutMs ?? 30_000,
  );
  try {
    await ready.promise;
  } finally {
    clearTimeout(timeout);
  }

  return {
    run(request, handlers = {}) {
      if (failure) return Promise.reject(failure);
      // The worker treats an invalid message as fatal, so a bad request must fail here, alone.
      const checked = agentRunRequestSchema.safeParse(request);
      if (!checked.success) {
        const issue = checked.error.issues[0];
        return Promise.reject(
          new Error(`Invalid agent run request at '${issue?.path.join(".")}': ${issue?.message}`),
        );
      }
      const runId = randomUUID();
      return new Promise<AgentRunOutcome>((resolve, reject) => {
        const onAbort = () => {
          if (pending.has(runId) && !failure) send({ type: "cancel", runId });
        };
        const settle = () => handlers.signal?.removeEventListener("abort", onAbort);
        pending.set(runId, {
          resolve: (outcome) => {
            settle();
            resolve(outcome);
          },
          reject: (error) => {
            settle();
            reject(error);
          },
          handlers,
        });
        try {
          send({ type: "run", runId, request });
        } catch (error) {
          pending.delete(runId);
          reject(error as Error);
          return;
        }
        if (handlers.signal?.aborted) onAbort();
        else handlers.signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    get failed() {
      return failure !== undefined;
    },
    kill(error) {
      fail(error);
    },
    async close() {
      if (!failure) {
        try {
          send({ type: "shutdown" });
          child.stdin.end();
        } catch {
          // The worker already exited.
        }
      }
      const forced = setTimeout(() => child.kill("SIGKILL"), shutdownGraceMs);
      await exited;
      clearTimeout(forced);
    },
  };
}

async function answerToolCall(
  handlers: AgentRunHandlers,
  call: Extract<WorkerMessage, { type: "tool-call" }>,
): Promise<ToolCallResult> {
  if (!handlers.onToolCall) {
    return { ok: false, error: `Tool '${call.tool}' is not available` };
  }
  try {
    return { ok: true, value: await handlers.onToolCall({ tool: call.tool, args: call.args }) };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  onChunk: (chunk: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    onChunk(decoder.decode(chunk, { stream: true }));
  }
}

function workerFlags(options: StartAgentWorkerOptions): string[] {
  return [
    ...(options.store ? ["--store", options.store] : []),
    ...(options.authFile ? ["--auth-file", options.authFile] : []),
    ...(options.providerModule ? ["--provider-module", options.providerModule] : []),
    ...(options.providerConfig ? ["--provider-config", options.providerConfig] : []),
    ...(options.abandonUnfinished ? ["--abandon-unfinished"] : []),
  ];
}

/**
 * Under Bun, the worker runs this runtime's worker entry. A compiled `pipr` binary carries the worker as its hidden
 * `agent-worker` subcommand instead.
 */
async function defaultAgentWorkerCommand(): Promise<string[]> {
  const executable = path.basename(process.execPath).replace(/\.exe$/, "");
  if (executable !== "bun") {
    return [process.execPath, "agent-worker"];
  }
  return [process.execPath, await agentWorkerEntryPath("main")];
}
