import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startFakeOpenAIGateway } from "../../tests/helpers/fake-openai-gateway.js";
import { type AgentWorkerClient, startAgentWorker } from "../client.js";
import type { AgentRunRequest, AgentWorkerEvent } from "../protocol.js";

const providerModule = path.join(import.meta.dir, "fixtures", "scripted-provider.ts");
const clients: AgentWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

function request(prompt: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    requestId: `request:${prompt}`,
    conversation: { kind: "new" },
    model: { provider: "fake", modelId: "reviewer", thinking: "off", apiKeyEnv: "FAKE_API_KEY" },
    systemPrompt: "You are a strict JSON API for pipr.",
    prompt,
    cwd: os.tmpdir(),
    tools: { workspace: [], bridged: [] },
    ...overrides,
  };
}

async function start() {
  const client = await startAgentWorker({
    env: { PATH: process.env.PATH, FAKE_API_KEY: "test-key" },
    cwd: os.tmpdir(),
    providerModule,
  });
  clients.push(client);
  return client;
}

describe("agent worker client", () => {
  it("runs a conversation in a worker process", async () => {
    const client = await start();
    const events: AgentWorkerEvent[] = [];

    const outcome = await client.run(request("hello"), { onEvent: (event) => events.push(event) });

    expect(outcome).toMatchObject({ status: "done", models: ["reviewer"] });
    expect(outcome.status === "done" && outcome.text).toContain("hello");
    expect(events).toContainEqual({ type: "first_response" });
  });

  it("answers bridged tool calls from the supervisor", async () => {
    const client = await start();
    const calls: unknown[] = [];

    const outcome = await client.run(
      request("use-tool", {
        tools: {
          workspace: [],
          bridged: [
            {
              name: "remember",
              description: "Read repository memory",
              parameters: { type: "object" },
            },
          ],
        },
      }),
      {
        onToolCall: async (call) => {
          calls.push(call);
          return { note: "prefer early returns" };
        },
      },
    );

    expect(calls).toEqual([{ tool: "remember", args: { key: "style" } }]);
    expect(outcome.status === "done" && outcome.text).toContain("prefer early returns");
  });

  it("reports an oversized bridged tool result to the model as a tool error", async () => {
    const client = await start();

    const outcome = await client.run(
      request("use-tool", {
        tools: {
          workspace: [],
          bridged: [
            { name: "remember", description: "Read memory", parameters: { type: "object" } },
          ],
        },
      }),
      { onToolCall: async () => "x".repeat(33 * 1024 * 1024) },
    );

    expect(outcome.status === "done" && outcome.text).toContain("exceeded the size limit");
    expect(client.failed).toBe(false);
  });

  it("rejects an invalid run request without failing the worker", async () => {
    const client = await start();

    await expect(client.run(request("hello", { timeoutMs: 0 }))).rejects.toThrow(
      "Invalid agent run request at 'timeoutMs'",
    );
    expect(client.failed).toBe(false);
    expect(await client.run(request("hello"))).toMatchObject({ status: "done" });
  });

  it("kills the worker and rejects its runs", async () => {
    const client = await start();
    const pending = client.run(
      request("use-tool", {
        tools: {
          workspace: [],
          bridged: [
            { name: "remember", description: "Read memory", parameters: { type: "object" } },
          ],
        },
      }),
      { onToolCall: () => new Promise(() => {}) },
    );

    client.kill(new Error("stuck worker"));

    await expect(pending).rejects.toThrow("stuck worker");
    expect(client.failed).toBe(true);
    await expect(client.run(request("hello"))).rejects.toThrow("stuck worker");
  });

  it("rejects pending runs when the worker process dies", async () => {
    const client = await start();

    await expect(client.run(request("crash-worker"))).rejects.toThrow(
      "agent worker exited with code 3",
    );
    await expect(client.run(request("hello"))).rejects.toThrow("agent worker exited");
  });

  it("registers a custom provider before resuming its unfinished run in a new worker", async () => {
    const held = Promise.withResolvers<string>();
    const gateway = startFakeOpenAIGateway({
      reply: (_request, index) => (index === 0 ? held.promise : "resumed answer"),
    });
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-worker-store-"));
    const worker = (store: string) =>
      startAgentWorker({
        env: { PATH: process.env.PATH, GATEWAY_KEY: "gw-key" },
        cwd: os.tmpdir(),
        store,
      });
    const gatewayRequest = request("resume me", {
      model: {
        provider: "gateway",
        modelId: "acme/house-model",
        thinking: "off",
        apiKeyEnv: "GATEWAY_KEY",
        endpoint: { api: "openai-completions", baseUrl: gateway.baseUrl },
      },
    });
    try {
      const store = path.join(directory, "store.sqlite");
      const first = await worker(store);
      clients.push(first);
      const interrupted = first.run(gatewayRequest).catch((error: unknown) => error);
      await waitFor(() => gateway.requests.length === 1);
      first.kill(new Error("worker lost"));
      expect(await interrupted).toBeInstanceOf(Error);

      const second = await worker(store);
      clients.push(second);
      // The restarted worker resumes the unfinished generation before it receives any run.
      await waitFor(() => gateway.requests.length === 2);
      const outcome = await second.run(gatewayRequest);

      expect(outcome).toMatchObject({ status: "done", text: "resumed answer" });
      expect(gateway.requests[1]).toMatchObject({
        authorization: "Bearer gw-key",
        body: { model: "acme/house-model" },
      });
    } finally {
      held.resolve("stale answer");
      await gateway.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports the worker diagnostics when it cannot start", async () => {
    await expect(
      startAgentWorker({
        env: { PATH: process.env.PATH },
        cwd: os.tmpdir(),
        providerModule: path.join(import.meta.dir, "fixtures", "missing-provider.ts"),
      }),
    ).rejects.toThrow("missing-provider");
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(20);
  }
}
