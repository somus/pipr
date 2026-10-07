import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { startFakeOpenAIGateway } from "../../tests/helpers/fake-openai-gateway.js";
import type { AgentRunRequest, WorkerMessage } from "../protocol.js";
import { type InProcessWorker, startInProcessWorker } from "./worker-harness.js";

const workers: InProcessWorker[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function request(overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    requestId: "work-1:task:agent:0",
    conversation: { kind: "new" },
    model: { provider: "fake", modelId: "reviewer", thinking: "off", apiKeyEnv: "FAKE_API_KEY" },
    systemPrompt: "You are a strict JSON API for pipr.",
    prompt: "Review the change.",
    cwd: os.tmpdir(),
    tools: { workspace: [], bridged: [] },
    ...overrides,
  };
}

function start(
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0],
  storePath?: string,
) {
  const faux = fauxProvider({ provider: "fake", models: [{ id: "reviewer" }] });
  faux.setResponses(responses);
  const worker = startInProcessWorker({
    providers: [faux.provider],
    env: { FAKE_API_KEY: "test-key" },
    storePath,
  });
  workers.push(worker);
  return { worker, faux };
}

function resultFor(runId: string) {
  return (message: WorkerMessage) => message.type === "result" && message.runId === runId;
}

async function run(worker: InProcessWorker, runId: string, runRequest: AgentRunRequest) {
  worker.send({ type: "run", runId, request: runRequest });
  const message = await worker.next(resultFor(runId));
  if (message.type !== "result") throw new Error("expected result");
  return message.outcome;
}

describe("agent worker", () => {
  it("announces the protocol and answers a run with text, usage, and models", async () => {
    const { worker } = start([fauxAssistantMessage([fauxText('{"summary":"ok"}')])]);
    expect(await worker.next((message) => message.type === "ready")).toEqual({
      type: "ready",
      protocol: 1,
    });

    const outcome = await run(worker, "run-1", request());

    expect(outcome).toMatchObject({
      status: "done",
      text: '{"summary":"ok"}',
      models: ["reviewer"],
    });
    if (outcome.status !== "done") throw new Error("expected done");
    expect(outcome.usage.inputTokens).toBeGreaterThan(0);
    expect(worker.messages).toContainEqual({
      type: "event",
      runId: "run-1",
      event: { type: "first_response" },
    });
  });

  it("puts the system prompt in the model context", async () => {
    let systemSections: unknown;
    const { worker } = start([
      (context) => {
        systemSections = context.messages.find((message) => message.role === "system");
        return fauxAssistantMessage([fauxText("{}")]);
      },
    ]);

    await run(worker, "run-1", request());

    expect(JSON.stringify(systemSections)).toContain("You are a strict JSON API for pipr.");
  });

  it("returns the settled answer for a repeated request id without calling the model again", async () => {
    const { worker, faux } = start([fauxAssistantMessage([fauxText("first")])]);

    const first = await run(worker, "run-1", request());
    const second = await run(worker, "run-2", request());

    expect(second).toMatchObject({ status: "done", text: "first" });
    expect(second.status === "done" && first.status === "done" && second.conversationId).toBe(
      first.status === "done" ? first.conversationId : -1,
    );
    expect(faux.state.callCount).toBe(1);
  });

  it("calls the model again for a repeated request id whose recorded answer failed", async () => {
    const { worker, faux } = start([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "invalid request" }),
      fauxAssistantMessage([fauxText("second")]),
    ]);

    const first = await run(worker, "run-1", request());
    const second = await run(worker, "run-2", request());
    const third = await run(worker, "run-3", request());

    expect(first).toMatchObject({ status: "failed", reason: "model_error" });
    expect(second).toMatchObject({ status: "done", text: "second" });
    expect(third).toMatchObject({ status: "done", text: "second" });
    expect(faux.state.callCount).toBe(2);
  });

  it("settles a timed-out run on a repeated cancel when the provider ignores abort", async () => {
    const { worker } = start([() => new Promise<never>(() => {})]);
    // The stuck generation never ends, so closing this worker would wait forever; its process owner kills it instead.
    workers.splice(workers.indexOf(worker), 1);
    worker.send({ type: "run", runId: "run-1", request: request({ timeoutMs: 50 }) });
    await Bun.sleep(150);

    worker.send({ type: "cancel", runId: "run-1" });
    const message = await worker.next(resultFor("run-1"));

    expect(message.type === "result" && message.outcome).toMatchObject({
      status: "failed",
      reason: "timeout",
    });
  });

  it("resumes a request from a durable store after the worker restarts", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-worker-store-"));
    directories.push(directory);
    const storePath = path.join(directory, "store.sqlite");
    const first = start([fauxAssistantMessage([fauxText("stored answer")])], storePath);
    await run(first.worker, "run-1", request());
    await first.worker.close();
    workers.splice(workers.indexOf(first.worker), 1);

    const second = start([fauxAssistantMessage([fauxText("rerun")])], storePath);
    const outcome = await run(second.worker, "run-1", request());

    expect(outcome).toMatchObject({ status: "done", text: "stored answer" });
    expect(second.faux.state.callCount).toBe(0);
  });

  it("serves custom provider models with default metadata and declared overrides", async () => {
    const gateway = startFakeOpenAIGateway({ reply: (_request, index) => `answer ${index}` });
    try {
      const worker = startInProcessWorker({ providers: [], env: { GATEWAY_KEY: "gw-key" } });
      workers.push(worker);
      const gatewayModel = (
        modelId: string,
        metadata?: NonNullable<AgentRunRequest["model"]["endpoint"]>["metadata"],
      ): AgentRunRequest["model"] => ({
        provider: "gateway",
        modelId,
        thinking: "off",
        apiKeyEnv: "GATEWAY_KEY",
        endpoint: {
          api: "openai-completions",
          baseUrl: gateway.baseUrl,
          ...(metadata ? { metadata } : {}),
        },
      });

      const unknown = await run(
        worker,
        "run-1",
        request({ requestId: "unknown", model: gatewayModel("acme/house-model") }),
      );
      const overridden = await run(
        worker,
        "run-2",
        request({
          requestId: "overridden",
          model: gatewayModel("acme/small-model", { maxTokens: 2048 }),
        }),
      );
      const priced = await run(
        worker,
        "run-3",
        request({
          requestId: "priced",
          model: gatewayModel("acme/priced-model", { cost: { input: 2, output: 10 } }),
        }),
      );

      expect(unknown).toMatchObject({ status: "done", text: "answer 0", usage: { costUsd: 0 } });
      expect(overridden).toMatchObject({ status: "done", text: "answer 1" });
      expect(priced).toMatchObject({ status: "done", text: "answer 2" });
      expect(priced.status === "done" ? priced.usage.costUsd : undefined).toBeCloseTo(
        (12 * 2 + 3 * 10) / 1_000_000,
        12,
      );
      expect(gateway.requests.map((call) => call.body.model)).toEqual([
        "acme/house-model",
        "acme/small-model",
        "acme/priced-model",
      ]);
      expect(gateway.requests[0]?.body).toMatchObject({ max_completion_tokens: 16_384 });
      expect(gateway.requests[1]?.body).toMatchObject({ max_completion_tokens: 2048 });
      expect(gateway.requests.map((call) => call.authorization)).toEqual([
        "Bearer gw-key",
        "Bearer gw-key",
        "Bearer gw-key",
      ]);
    } finally {
      await gateway.stop();
    }
  });

  it("refuses a custom endpoint for a built-in provider id", async () => {
    const worker = startInProcessWorker({ providers: [], env: { DEEPSEEK_API_KEY: "key" } });
    workers.push(worker);

    const outcome = await run(
      worker,
      "run-1",
      request({
        model: {
          provider: "deepseek",
          modelId: "deepseek-v4-pro",
          thinking: "off",
          apiKeyEnv: "DEEPSEEK_API_KEY",
          endpoint: { api: "openai-completions", baseUrl: "https://gateway.example/v1" },
        },
      }),
    );

    expect(outcome).toMatchObject({
      status: "failed",
      reason: "invalid_request",
      error: "custom provider 'deepseek' collides with a built-in Pi provider",
    });
  });

  it("continues a conversation so a repair follow-up sees the earlier answer", async () => {
    let followUpMessages: string[] = [];
    const { worker } = start([
      fauxAssistantMessage([fauxText("{invalid")]),
      (context) => {
        followUpMessages = context.messages
          .filter((message) => message.role === "user" || message.role === "assistant")
          .map((message) => JSON.stringify(message.content));
        return fauxAssistantMessage([fauxText('{"fixed":true}')]);
      },
    ]);
    const first = await run(worker, "run-1", request());
    if (first.status !== "done") throw new Error("expected done");

    const repaired = await run(
      worker,
      "run-2",
      request({
        requestId: "work-1:task:agent:0:repair",
        conversation: { kind: "continue", conversationId: first.conversationId },
        prompt: "Repair the previous output.",
      }),
    );

    expect(repaired).toMatchObject({
      status: "done",
      text: '{"fixed":true}',
      conversationId: first.conversationId,
    });
    expect(followUpMessages.join("\n")).toContain("{invalid");
    expect(followUpMessages.join("\n")).toContain("Repair the previous output.");
  });

  it("forks branches from one parent conversation that holds the shared prefix", async () => {
    const seen: string[][] = [];
    const answer = (context: { messages: Array<{ role: string; content: unknown }> }) => {
      seen.push(
        context.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content)),
      );
      return fauxAssistantMessage([fauxText(`branch-${seen.length}`)]);
    };
    const { worker } = start([answer, answer]);
    const fork = {
      kind: "fork" as const,
      parentKey: "work-1:diff",
      parentPrompt: "Shared diff context.",
    };

    const [left, right] = await Promise.all([
      run(
        worker,
        "run-1",
        request({ requestId: "left", conversation: fork, prompt: "Focus: security" }),
      ),
      run(
        worker,
        "run-2",
        request({ requestId: "right", conversation: fork, prompt: "Focus: tests" }),
      ),
    ]);

    expect(left.status).toBe("done");
    expect(right.status).toBe("done");
    expect(
      left.status === "done" &&
        right.status === "done" &&
        left.conversationId !== right.conversationId,
    ).toBe(true);
    for (const users of seen) {
      expect(users[0]).toContain("Shared diff context.");
    }
    expect(seen.map((users) => users.at(-1)).sort()).toEqual([
      '"Focus: security"',
      '"Focus: tests"',
    ]);
  });

  it("bridges plugin tool calls to the supervisor and returns the result to the model", async () => {
    let toolResult: unknown;
    const { worker } = start([
      fauxAssistantMessage([fauxToolCall("remember", { key: "style" })], { stopReason: "toolUse" }),
      (context) => {
        toolResult = context.messages.at(-1);
        return fauxAssistantMessage([fauxText("{}")]);
      },
    ]);
    worker.send({
      type: "run",
      runId: "run-1",
      request: request({
        tools: {
          workspace: [],
          bridged: [
            {
              name: "remember",
              description: "Read repository memory",
              parameters: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
              },
            },
          ],
        },
      }),
    });

    const call = await worker.next((message) => message.type === "tool-call");
    expect(call).toMatchObject({
      type: "tool-call",
      runId: "run-1",
      tool: "remember",
      args: { key: "style" },
    });
    if (call.type !== "tool-call") throw new Error("expected tool call");
    worker.send({
      type: "tool-result",
      runId: "run-1",
      callId: call.callId,
      result: { ok: true, value: { note: "prefer early returns" } },
    });
    const outcome = await worker.next(resultFor("run-1"));

    expect(outcome).toMatchObject({ type: "result", outcome: { status: "done" } });
    expect(JSON.stringify(toolResult)).toContain("prefer early returns");
    expect(worker.messages).toContainEqual(
      expect.objectContaining({
        type: "event",
        event: expect.objectContaining({
          type: "tool_execution_end",
          toolName: "remember",
          isError: false,
        }),
      }),
    );
  });

  it("offers only the requested workspace tools, scoped to the run workspace", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-agent-workspace-"));
    directories.push(workspace);
    await Bun.write(path.join(workspace, "notes.md"), "remember the workspace\n");
    let offered: string[] = [];
    let toolResult: unknown;
    const { worker } = start([
      (context) => {
        offered = context.messages.flatMap((message) =>
          message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        return fauxAssistantMessage([fauxToolCall("read", { path: "notes.md" })], {
          stopReason: "toolUse",
        });
      },
      (context) => {
        toolResult = context.messages.at(-1);
        return fauxAssistantMessage([fauxText("{}")]);
      },
    ]);

    const outcome = await run(
      worker,
      "run-1",
      request({ cwd: workspace, tools: { workspace: ["read"], bridged: [] } }),
    );

    expect(outcome).toMatchObject({ status: "done" });
    expect(offered).toEqual(["read"]);
    expect(JSON.stringify(toolResult)).toContain("remember the workspace");
  });

  it("fails a run whose model API key is missing from the worker environment", async () => {
    const { worker } = start([fauxAssistantMessage([fauxText("{}")])]);

    const outcome = await run(
      worker,
      "run-1",
      request({
        model: { provider: "fake", modelId: "reviewer", thinking: "off", apiKeyEnv: "MISSING_KEY" },
      }),
    );

    expect(outcome).toMatchObject({ status: "failed", reason: "invalid_request" });
    expect(outcome.status === "failed" && outcome.error).toContain("MISSING_KEY");
  });

  it("fails a run that exceeds its timeout", async () => {
    const { worker } = start([
      async () => {
        await Bun.sleep(2_000);
        return fauxAssistantMessage([fauxText("late")]);
      },
    ]);

    const outcome = await run(worker, "run-1", request({ timeoutMs: 50 }));

    expect(outcome).toMatchObject({ status: "failed", reason: "timeout" });
  });
});
