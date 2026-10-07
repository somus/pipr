import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ScriptedProviderScript } from "../../agent-worker/scripted-provider.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import { createScriptedPi, type ScriptedPi } from "../../tests/helpers/scripted-pi.js";
import { ProviderExecutionError } from "../provider-failure.js";
import { createDurablePiRunner, withPiRunWorkspace } from "../runner.js";

/** One model call in a runner of its own. */
async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  return await withPiRunWorkspace(
    { workspace: options.workspace, env: options.env },
    async (runner) => await runner(options),
  );
}

import type { PiRunOptions, PiRunResult } from "../types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("durable Pi runner", () => {
  it("returns the answer with the responding model and usage", async () => {
    const { pi, runOptions } = await fixture({ responses: [{ text: '{"ok":true}' }] });

    const result = await runPi(runOptions());

    expect(result).toMatchObject({
      text: '{"ok":true}',
      conversationId: expect.any(Number),
      models: ["deepseek-v4-pro"],
      usage: { status: "complete", costUsd: 0 },
    });
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(await pi.prompts()).toEqual(["Review this diff."]);
  });

  it("offers read-only workspace tools and only the runtime tools that were requested", async () => {
    const { pi, runOptions } = await fixture();

    await runPi(runOptions());
    await runPi(
      runOptions({
        builtinTools: ["read"],
        runtimeTools: { manifest: reviewTestManifest(), toolResponseMaxBytes: 10_000 },
      }),
    );

    const [plain, withRuntime] = await pi.calls();
    expect(plain?.tools).toEqual(["read", "grep", "find", "ls"]);
    expect(withRuntime?.tools).toEqual(["read", "pipr_read_diff", "pipr_read_at_ref"]);
  });

  it("copies the workspace without symlinks or captured run bundles", async () => {
    const { workspace, pi, runOptions } = await fixture({
      responses: [{ toolCalls: [{ name: "ls", args: {} }] }, { text: "done" }],
    });
    await Bun.write(path.join(workspace, "target.txt"), "ok\n");
    await symlink(path.join(workspace, "target.txt"), path.join(workspace, "link.txt"));
    await Bun.write(path.join(workspace, ".pipr-runs", "previous", "run.json"), "{}\n");

    await runPi(runOptions());

    const listing = toolResultText((await pi.calls())[1]);
    expect(listing).toContain("target.txt");
    expect(listing).not.toContain("link.txt");
    expect(listing).not.toContain(".pipr-runs");
  });

  it("reads one workspace snapshot for every call in a runner scope", async () => {
    const { workspace, pi, runOptions } = await fixture({
      responses: [
        { text: "first" },
        { toolCalls: [{ name: "read", args: { path: "marker.txt" } }] },
        { text: "second" },
      ],
    });
    await Bun.write(path.join(workspace, "marker.txt"), "snapshot\n");

    await withPiRunWorkspace({ workspace }, async (runner) => {
      await runner(runOptions({ prompt: "First." }));
      await Bun.write(path.join(workspace, "marker.txt"), "changed after snapshot\n");
      await runner(runOptions({ prompt: "Second." }));
    });

    expect(toolResultText((await pi.calls())[2])).toContain("snapshot");
    expect(toolResultText((await pi.calls())[2])).not.toContain("changed");
  });

  it("passes only the provider's variables to the agent worker, never CI tokens", async () => {
    const { workspace, runOptions } = await fixture({
      responses: [
        {
          error: [
            `key=${envRef("DEEPSEEK_API_KEY")}`,
            `account=${envRef("DEEPSEEK_ACCOUNT_ID")}`,
            `credential=${envRef("DEEPSEEK_OAUTH_TOKEN")}`,
            `github=${envRef("GITHUB_TOKEN")}`,
            `actions=${envRef("ACTIONS_RUNTIME_TOKEN")}`,
            `azure=${envRef("SYSTEM_ACCESSTOKEN")}`,
            `gitlab=${envRef("CI_JOB_TOKEN")}`,
            `other=${envRef("SECRET_SHOULD_NOT_LEAK")}`,
          ].join(" "),
        },
      ],
    });
    const env = {
      DEEPSEEK_API_KEY: "provided-key",
      DEEPSEEK_ACCOUNT_ID: "account-1",
      DEEPSEEK_OAUTH_TOKEN: "oauth-1",
      GITHUB_TOKEN: "ghs_secret",
      ACTIONS_RUNTIME_TOKEN: "actions-secret",
      SYSTEM_ACCESSTOKEN: "azure-secret",
      CI_JOB_TOKEN: "gitlab-secret",
      SECRET_SHOULD_NOT_LEAK: "hidden",
      PATH: process.env.PATH,
    };

    const failure = await withPiRunWorkspace({ workspace, env }, async (runner) =>
      runner(
        runOptions({
          env: undefined,
          provider: {
            ...deepseekProvider(),
            providerEnv: ["DEEPSEEK_ACCOUNT_ID"],
            credentialEnv: ["DEEPSEEK_OAUTH_TOKEN"],
          },
        }),
      ),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect((failure as ProviderExecutionError).message).toBe("Pi agent failed (model_error)");
    expect((failure as ProviderExecutionError).detail).toBe(
      "key=provided-key account=account-1 credential=oauth-1 github= actions= azure= gitlab= other=",
    );
  });

  it("gives an auth-file worker no provider key or CI token from the environment", async () => {
    const { workspace, runOptions } = await fixture({
      responses: [
        { error: `key=${envRef("DEEPSEEK_API_KEY")} github=${envRef("GITHUB_TOKEN")} end` },
      ],
    });
    const authFile = path.join(await temporaryDirectory("pipr-auth-"), "auth.json");
    await Bun.write(authFile, JSON.stringify({ deepseek: { type: "api_key", key: "file-key" } }));
    const env = {
      DEEPSEEK_API_KEY: "env-key",
      GITHUB_TOKEN: "ghs_secret",
      PATH: process.env.PATH,
    };

    const failure = await withPiRunWorkspace({ workspace, env }, async (runner) =>
      runner(
        runOptions({
          env: undefined,
          authFile,
          provider: { ...deepseekProvider(), apiKeyEnv: undefined },
        }),
      ),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ProviderExecutionError);
    expect((failure as ProviderExecutionError).detail).toBe("key= github= end");
  });

  it("replaces a worker that crashed on the next call of the same runner", async () => {
    // Every "Crash." call exits, so the replacement would die too if it resumed the abandoned run.
    const { workspace, pi, runOptions } = await fixture({
      rules: [{ when: { promptIncludes: "Crash." }, response: { exitCode: 3 } }],
      responses: [{ text: "recovered" }],
    });

    await withPiRunWorkspace({ workspace }, async (runner) => {
      const failure = await runner(runOptions({ prompt: "Crash." })).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(ProviderExecutionError);
      expect((failure as ProviderExecutionError).message).toBe("Pi agent worker failed");
      expect((failure as ProviderExecutionError).detail).toContain("exited with code 3");

      await expect(runner(runOptions({ prompt: "Again." }))).resolves.toMatchObject({
        text: "recovered",
      });
    });
    expect((await pi.prompts()).sort()).toEqual(["Again.", "Crash."]);
  });

  it("kills a worker that ignores its timeout and replaces it on the next call", async () => {
    const { workspace, pi, runOptions } = await fixture({
      rules: [{ when: { promptIncludes: "Hang." }, response: { hangMs: 10_000 } }],
      responses: [{ text: "recovered" }],
    });

    await withPiRunWorkspace(
      { workspace, supervisorGraceMs: { cancel: 100, kill: 100 } },
      async (runner) => {
        const started = Date.now();
        const failure = await runner(runOptions({ prompt: "Hang.", timeoutSeconds: 0.2 })).catch(
          (error: unknown) => error,
        );
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(failure).toBeInstanceOf(ProviderExecutionError);
        expect((failure as ProviderExecutionError).message).toBe("Pi agent worker failed");
        expect((failure as ProviderExecutionError).detail).toBe(
          "Pi timed out after 0.2s and the agent worker did not stop",
        );

        await expect(runner(runOptions({ prompt: "Again." }))).resolves.toMatchObject({
          text: "recovered",
        });
      },
    );
    // The replacement abandons the hung run instead of resuming it.
    expect((await pi.prompts()).sort()).toEqual(["Again.", "Hang."]);
  });

  it("rejects models without credentials before starting the agent", async () => {
    const { pi, runOptions } = await fixture();

    await expect(runPi(runOptions({ env: { PATH: process.env.PATH } }))).rejects.toThrow(
      "Missing provider env var for model 'deepseek': DEEPSEEK_API_KEY",
    );
    await expect(
      runPi(runOptions({ provider: { ...deepseekProvider(), apiKeyEnv: undefined } })),
    ).rejects.toThrow("Model 'deepseek' does not declare apiKey and requires a Pi auth file");
    expect(await pi.calls()).toEqual([]);
  });

  it("rejects incomplete or root Pi sandbox identities", async () => {
    const { runOptions } = await fixture();
    const env = { DEEPSEEK_API_KEY: "provided-key", PATH: process.env.PATH };

    await expect(
      runPi(runOptions({ env: { ...env, PIPR_PI_SANDBOX_UID: "1000" } })),
    ).rejects.toThrow("PIPR_PI_SANDBOX_UID and PIPR_PI_SANDBOX_GID must be configured together");
    await expect(
      runPi(runOptions({ env: { ...env, PIPR_PI_SANDBOX_UID: "0", PIPR_PI_SANDBOX_GID: "1000" } })),
    ).rejects.toThrow("PIPR_PI_SANDBOX_UID must be a positive integer");
  });

  it("bridges custom tools to supervisor-side handlers", async () => {
    const { pi, runOptions } = await fixture({
      responses: [
        { toolCalls: [{ name: "plugin_echo", args: { value: "hello" } }] },
        { text: "done" },
      ],
    });
    const inputs: unknown[] = [];

    await runPi(
      runOptions({
        customTools: {
          context: { run: { id: "test" } },
          tools: [
            {
              name: "plugin_echo",
              description: "Echo input.",
              input: passthroughSchema(),
              output: passthroughSchema(),
              async execute(_context, input) {
                inputs.push(input);
                return { echoed: input };
              },
            },
          ],
        } as PiRunOptions["customTools"],
      }),
    );

    expect(inputs).toEqual([{ value: "hello" }]);
    expect(toolResultText((await pi.calls())[1])).toContain('"echoed"');
  });

  it("rejects custom tools that collide with runtime tool names", async () => {
    const { pi, runOptions } = await fixture();

    await expect(
      runPi(
        runOptions({
          runtimeTools: { manifest: reviewTestManifest(), toolResponseMaxBytes: 10_000 },
          customTools: {
            context: { run: { id: "test" } },
            tools: [
              {
                name: "pipr_read_diff",
                input: passthroughSchema(),
                output: passthroughSchema(),
                async execute(_context, input) {
                  return input;
                },
              },
            ],
          } as PiRunOptions["customTools"],
        }),
      ),
    ).rejects.toThrow("Pi tool name 'pipr_read_diff' is registered more than once");
    expect(await pi.calls()).toEqual([]);
  });

  it("collects Diff Manifest coverage from runtime read tools", async () => {
    const manifest = reviewTestManifest();
    const { runOptions } = await fixture({
      responses: [
        { toolCalls: [{ name: "pipr_read_diff", args: { path: "src/a.ts" } }] },
        { text: "{}" },
      ],
    });

    const result = await runPi(
      runOptions({
        runtimeTools: { manifest, toolResponseMaxBytes: 100_000 },
        diffContext: { manifest, mode: "condensed" },
      }),
    );

    expect(result.diffContextCoverage?.files).toEqual([
      expect.objectContaining({ path: "src/a.ts", fullFile: true }),
    ]);
  });

  it("returns the recorded answer when a request id repeats", async () => {
    const { workspace, pi, runOptions } = await fixture({
      responses: [{ text: "first answer" }, { text: "second answer" }],
    });
    const storeDir = await temporaryDirectory("pipr-agent-store-");

    const answers: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await withPiRunWorkspace({ workspace, storeDir }, async (runner) => {
        answers.push((await runner(runOptions({ requestId: "request-1" }))).text);
      });
    }

    expect(answers).toEqual(["first answer", "first answer"]);
    expect(await pi.calls()).toHaveLength(1);
  });

  it("times out slow model calls", async () => {
    const { runOptions } = await fixture({ responses: [{ text: "late", delayMs: 5_000 }] });

    await expect(runPi(runOptions({ timeoutSeconds: 1 }))).rejects.toThrow(
      "Pi agent failed (timeout)",
    );
  });

  it("creates the sandbox on first use and refuses calls after close", async () => {
    const { runOptions } = await fixture();
    const runner = createDurablePiRunner({ workspace: runOptions().workspace });
    await runner.close();
    const reopened = createDurablePiRunner({ workspace: runOptions().workspace });

    await expect(reopened(runOptions())).resolves.toMatchObject({ text: expect.any(String) });
    await reopened.close();
    await expect(reopened(runOptions())).rejects.toThrow("Pi runner is closed");
  });
});

async function fixture(script: Partial<Omit<ScriptedProviderScript, "recordPath">> = {}): Promise<{
  workspace: string;
  pi: ScriptedPi;
  runOptions: (patch?: Partial<PiRunOptions>) => PiRunOptions;
}> {
  const workspace = await temporaryDirectory("pipr-source-");
  const pi = await createScriptedPi(await temporaryDirectory("pipr-scripted-pi-"), script);
  return {
    workspace,
    pi,
    runOptions: (patch = {}) => ({
      workspace,
      prompt: "Review this diff.",
      provider: deepseekProvider(),
      env: { DEEPSEEK_API_KEY: "provided-key", PATH: process.env.PATH },
      providerModule: pi.providerModule,
      ...patch,
    }),
  };
}

function deepseekProvider(): PiRunOptions["provider"] {
  return {
    id: "deepseek",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    thinking: "high",
    apiKeyEnv: "DEEPSEEK_API_KEY",
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return directory;
}

function toolResultText(
  call: { messages: Array<{ role: string; text: string }> } | undefined,
): string {
  return call?.messages.findLast((message) => message.role === "toolResult")?.text ?? "";
}

function passthroughSchema() {
  return {
    parse(value: unknown) {
      return value;
    },
  };
}

/** A `${env:NAME}` placeholder that the scripted provider expands from the worker environment. */
function envRef(name: string): string {
  return `\${env:${name}}`;
}
