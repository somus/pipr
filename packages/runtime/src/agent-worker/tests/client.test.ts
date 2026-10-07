import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AgentWorkerClient, startAgentWorker } from "../client.js";
import type { AgentRunRequest, AgentWorkerEvent } from "../protocol.js";

const providerModule = path.join(import.meta.dir, "fixtures", "scripted-provider.ts");
const clients: AgentWorkerClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
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

async function start(store?: string) {
  const client = await startAgentWorker({
    env: { PATH: process.env.PATH, FAKE_API_KEY: "test-key" },
    cwd: os.tmpdir(),
    providerModule,
    store,
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

  it("keeps conversations in the store across worker processes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-agent-client-"));
    directories.push(directory);
    const store = path.join(directory, "agent.sqlite");
    const first = await start(store);
    const initial = await first.run(request("hello"));
    await first.close();
    clients.splice(clients.indexOf(first), 1);
    if (initial.status !== "done") throw new Error("expected done");

    const second = await start(store);
    const repeated = await second.run(request("hello"));

    expect(repeated).toMatchObject({
      status: "done",
      conversationId: initial.conversationId,
      text: initial.text,
    });
  });

  it("rejects pending runs when the worker process dies", async () => {
    const client = await start();

    await expect(client.run(request("crash-worker"))).rejects.toThrow(
      "agent worker exited with code 3",
    );
    await expect(client.run(request("hello"))).rejects.toThrow("agent worker exited");
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
