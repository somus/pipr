import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRunRequest } from "../protocol.js";
import scriptedProviders, { type ScriptedModelCall } from "../scripted-provider.js";
import { type InProcessWorker, startInProcessWorker } from "./worker-harness.js";

const workers: InProcessWorker[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("scripted provider", () => {
  it("records the system prompt and messages each model call received", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-scripted-provider-"));
    directories.push(directory);
    const recordPath = path.join(directory, "calls.jsonl");
    const scriptPath = path.join(directory, "script.json");
    await writeFile(
      scriptPath,
      JSON.stringify({ models: ["fake/reviewer"], responses: [{ text: "ok" }], recordPath }),
    );
    const worker = startInProcessWorker({
      providers: await scriptedProviders(scriptPath),
      env: { FAKE_API_KEY: "test-key" },
    });
    workers.push(worker);
    const request: AgentRunRequest = {
      requestId: "scripted:0",
      conversation: { kind: "new" },
      model: { provider: "fake", modelId: "reviewer", thinking: "off", apiKeyEnv: "FAKE_API_KEY" },
      systemPrompt: "You are a strict JSON API for pipr.",
      prompt: "Review the change.",
      cwd: os.tmpdir(),
      tools: { workspace: [], bridged: [] },
    };

    worker.send({ type: "run", runId: "run-1", request });
    await worker.next((message) => message.type === "result" && message.runId === "run-1");

    const [call] = (await readFile(recordPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as ScriptedModelCall);
    expect(call?.model).toBe("fake/reviewer");
    expect(call?.system.join("\n")).toContain("You are a strict JSON API for pipr.");
    expect(call?.messages).toContainEqual({ role: "user", text: "Review the change." });
  });
});
