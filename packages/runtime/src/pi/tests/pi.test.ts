import { describe, expect, it } from "bun:test";
import { chmod, lstat, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DiffManifest } from "../../types.js";
import {
  parsePiProviderInvocation,
  parsePiProviderProfile,
  piBuiltinToolNames,
  piReadOnlyToolNames,
  piRequiredCliFlags,
  piThinkingLevels,
} from "../contract.js";
import { toPiProviderInvocation } from "../provider.js";
import { buildPiArgs, createReadOnlyWorkspace, type PiRunOptions, runPi } from "../runner.js";
import { piRuntimeReadToolNames } from "../runtime-tools.js";

describe("Pi contract", () => {
  it("tracks the Pi CLI contract pipr depends on", () => {
    expect(piThinkingLevels).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
    expect(piBuiltinToolNames).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
    expect(piReadOnlyToolNames).toEqual(["read", "grep", "find", "ls"]);
    expect(piRequiredCliFlags).toEqual([
      "--provider",
      "--model",
      "--system-prompt",
      "--mode",
      "--print",
      "--no-session",
      "--session-dir",
      "--tools",
      "--extension",
      "--no-context-files",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
    ]);
  });

  it("accepts only Pi-native provider profile fields", () => {
    expect(
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
      }),
    ).toMatchObject({ thinking: "high" });

    expect(() =>
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        options: { reasoning_effort: "high" },
      }),
    ).toThrow();
    expect(() =>
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "enabled",
      }),
    ).toThrow();
  });

  it("keeps Pi invocation read-only and schema-backed", () => {
    expect(
      parsePiProviderInvocation({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
        tools: ["read", "grep", "find", "ls"],
      }),
    ).toMatchObject({ tools: ["read", "grep", "find", "ls"] });

    expect(() =>
      parsePiProviderInvocation({
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
        tools: ["read", "bash", "grep", "find", "ls"],
      }),
    ).toThrow();
  });
});

describe("buildPiArgs", () => {
  it("uses real Pi CLI flags with explicit read-only tools and without PR-controlled context", () => {
    const args = buildPiArgs(
      {
        id: "backup",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "high",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      "Review this diff.",
      "/tmp/pipr-session",
    );

    expect(args).toEqual([
      "--provider",
      "deepseek",
      "--model",
      "deepseek-v4-pro",
      "--system-prompt",
      expect.stringContaining("strict JSON API"),
      "--mode",
      "json",
      "--print",
      "--no-session",
      "--session-dir",
      "/tmp/pipr-session",
      "--tools",
      "read,grep,find,ls",
      "--no-context-files",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--thinking",
      "high",
      "Review this diff.",
    ]);
    expect(args[5]).toContain("The first non-whitespace character must be { or [");
    expect(args[5]).toContain("Do not include Markdown, code fences");
    expect(args).not.toContain("--no-tools");
    expect(args).not.toContain("--no-builtin-tools");
    expect(args).not.toContain("bash");
    expect(args).not.toContain("write");
    expect(args).not.toContain("edit");
  });

  it("uses Pi-native provider thinking levels", () => {
    expect(
      toPiProviderInvocation({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "xhigh",
      }).thinking,
    ).toBe("xhigh");
    expect(
      toPiProviderInvocation({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "off",
      }).thinking,
    ).toBe("off");
  });

  it("adds pipr Diff Read Tools through an explicit extension", () => {
    const args = buildPiArgs(
      {
        id: "backup",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "high",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      "Review this diff.",
      "/tmp/pipr-session",
      {
        extensionPath: "/tmp/runtime-tools-extension.mjs",
        runtimeRead: {
          extensionPath: "/tmp/runtime-tools-extension.mjs",
          dataPath: "/tmp/pipr-runtime-tools-data.json",
          toolNames: piRuntimeReadToolNames,
        },
        toolNames: piRuntimeReadToolNames,
      },
    );

    expect(args).toContain("--no-extensions");
    expect(args).toContain("--no-extensions");
    expectPiExtension(args, "/tmp/runtime-tools-extension.mjs");
    expect(expectPiTools(args)).toBe("read,grep,find,ls,pipr_read_diff,pipr_read_at_ref");
    expect(expectPiTools(args)).not.toContain("bash");
    expect(expectPiTools(args)).not.toContain("edit");
    expect(expectPiTools(args)).not.toContain("write");
  });

  it("preserves an explicit empty built-in tool list", () => {
    const args = buildPiArgs(
      {
        id: "backup",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "high",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      "Verify this finding.",
      "/tmp/pipr-session",
      undefined,
      [],
    );

    expect(expectPiTools(args)).toBe("");
  });

  it("adds registered custom tools through the same explicit extension", () => {
    const args = buildPiArgs(
      {
        id: "backup",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        thinking: "high",
        apiKeyEnv: "DEEPSEEK_API_KEY",
      },
      "Review this diff.",
      "/tmp/pipr-session",
      {
        extensionPath: "/tmp/runtime-tools-extension.mjs",
        custom: {
          extensionPath: "/tmp/runtime-tools-extension.mjs",
          dataPath: "/tmp/pipr-custom-tools-data.json",
          bridgeUrl: "http://127.0.0.1:1234",
          bridgeToken: "token",
          toolNames: ["plugin_echo"],
          async close() {},
        },
        toolNames: ["plugin_echo"],
      },
    );

    expectPiExtension(args, "/tmp/runtime-tools-extension.mjs");
    expect(expectPiTools(args)).toBe("read,grep,find,ls,plugin_echo");
  });

  it("drops symlinks from the read-only workspace copy", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    let copy: string | undefined;
    try {
      await Bun.write(path.join(workspace, "target.txt"), "ok\n");
      await symlink(path.join(workspace, "target.txt"), path.join(workspace, "link.txt"));

      copy = await createReadOnlyWorkspace(workspace);

      await expect(lstat(path.join(copy, "link.txt"))).rejects.toThrow();
      await expect(lstat(path.join(copy, "target.txt"))).resolves.toBeDefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
      if (copy) {
        await chmodTree(copy, 0o755);
        await rm(copy, { recursive: true, force: true });
      }
    }
  });

  it("does not leak unrelated parent env vars into Pi", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi.sh");
    const previousProviderKey = process.env.DEEPSEEK_API_KEY;
    const previousSecret = process.env.SECRET_SHOULD_NOT_LEAK;
    try {
      await Bun.write(piExecutable, "#!/bin/sh\nprintenv\n");
      await chmod(piExecutable, 0o755);
      process.env.DEEPSEEK_API_KEY = "provider-key";
      process.env.SECRET_SHOULD_NOT_LEAK = "hidden";

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        provider: {
          id: "backup",
          provider: "deepseek",
          model: "deepseek-v4-pro",
          thinking: "high",
          apiKeyEnv: "DEEPSEEK_API_KEY",
        },
      });

      expect(result.exitCode).toBe(0);
      const hostHome = os.homedir();
      expect(result.stdout).toContain("DEEPSEEK_API_KEY=provider-key");
      expect(result.stdout).toContain("HOME=");
      expect(result.stdout).toContain("PI_CODING_AGENT_DIR=");
      expect(result.stdout).toContain("PI_CODING_AGENT_SESSION_DIR=");
      expect(result.stdout).toContain("PIPR_PROVIDER_ID=backup");
      expect(result.stdout).not.toContain(`HOME=${hostHome}`);
      expect(result.stdout).not.toContain("PIPR_RUNTIME_TOOLS_DATA=");
      expect(result.stdout).not.toContain("PIPR_CUSTOM_TOOLS_DATA=");
      expect(result.stdout).not.toContain("PIPR_CUSTOM_TOOLS_BRIDGE_URL=");
      expect(result.stdout).not.toContain("PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN=");
      expect(result.stdout).not.toContain("SECRET_SHOULD_NOT_LEAK");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousProviderKey);
      restoreEnv("SECRET_SHOULD_NOT_LEAK", previousSecret);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes runtime tool data env only when condensed runtime tools are enabled", async () => {
    const result = await runFakePiWithToolOptions({
      runtimeTools: {
        manifest: emptyDiffManifest(),
        toolResponseMaxBytes: 10_000,
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PIPR_RUNTIME_TOOLS_DATA=");
    expect(result.stdout).toContain("runtime-tools/data.json");
    expect(result.stdout).toContain("--extension");
    expect(result.stdout).toMatch(/runtime-tools-extension\.(ts|mjs)/);
  });

  it("passes custom tool bridge env only when custom tools are enabled", async () => {
    const result = await runFakePiWithToolOptions({
      customTools: {
        context: { run: { id: "test" } },
        tools: [
          {
            name: "plugin_echo",
            description: "Echo input.",
            input: passthroughSchema(),
            output: passthroughSchema(),
            async execute(_context, input) {
              return input;
            },
          },
        ],
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PIPR_CUSTOM_TOOLS_DATA=");
    expect(result.stdout).toContain("custom-tools/data.json");
    expect(result.stdout).toContain("PIPR_CUSTOM_TOOLS_BRIDGE_URL=http://127.0.0.1:");
    expect(result.stdout).toContain("PIPR_CUSTOM_TOOLS_BRIDGE_TOKEN=");
    expect(result.stdout).toContain("--extension");
    expect(result.stdout).toMatch(/runtime-tools-extension\.(ts|mjs)/);
    expect(result.stdout).toContain("read,grep,find,ls,plugin_echo");
    expect(result.stdout).not.toContain("PIPR_RUNTIME_TOOLS_DATA=");
  });

  it("copies provider keys from the supplied source env", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi.sh");
    const previousProviderKey = process.env.DEEPSEEK_API_KEY;
    try {
      await Bun.write(piExecutable, "#!/bin/sh\nprintenv\n");
      await chmod(piExecutable, 0o755);
      delete process.env.DEEPSEEK_API_KEY;

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        ...deepseekRunOptions(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("DEEPSEEK_API_KEY=provided-key");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousProviderKey);
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("passes large prompts through an @file argument", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi.sh");
    const prompt = "Review this diff.\n".repeat(20_000);
    try {
      await Bun.write(
        piExecutable,
        [
          "#!/bin/sh",
          'for arg in "$@"; do',
          '  case "$arg" in',
          "    @*) prompt_path=$" + "{arg#@}; printf 'PROMPT_BYTES='; wc -c < \"$prompt_path\" ;;",
          "  esac",
          "done",
          "printf 'ARGS=%s\\n' \"$*\"",
        ].join("\n"),
      );
      await chmod(piExecutable, 0o755);

      const result = await runPi({
        workspace,
        piExecutable,
        prompt,
        ...deepseekRunOptions(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/PROMPT_BYTES=\s*360000/);
      expect(result.stdout).toContain("@");
      expect(result.stdout).not.toContain(prompt);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("extracts assistant text from Pi JSON event streams", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "fake-pi");
    const reviewJson = '{"summary":{"body":"No findings."},"inlineFindings":[]}';
    try {
      await Bun.write(
        piExecutable,
        [
          "#!/usr/bin/env bun",
          'console.log(JSON.stringify({ type: "session", version: 3 }));',
          `console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: ${JSON.stringify(
            reviewJson,
          )} }] } }));`,
        ].join("\n"),
      );
      await chmod(piExecutable, 0o755);

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        ...deepseekRunOptions(),
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(reviewJson);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("times out long-running Pi subprocesses", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
    const piExecutable = path.join(workspace, "slow-pi.sh");
    try {
      await Bun.write(piExecutable, "#!/bin/sh\nsleep 2\nprintf '{}\\n'\n");
      await chmod(piExecutable, 0o755);

      const result = await runPi({
        workspace,
        piExecutable,
        prompt: "Review this diff.",
        timeoutSeconds: 1,
        ...deepseekRunOptions({ id: "backup" }),
      });

      expect(result.exitCode).toBe(124);
      expect(result.stderr).toContain("Pi timed out after 1s");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

function emptyDiffManifest(): DiffManifest {
  return {
    baseSha: "base",
    headSha: "head",
    mergeBaseSha: "base",
    files: [],
  };
}

function expectPiExtension(args: string[], extensionPath: string): void {
  expect(args).toContain("--extension");
  expect(args[args.indexOf("--extension") + 1]).toBe(extensionPath);
}

function expectPiTools(args: string[]): string {
  return args[args.indexOf("--tools") + 1] ?? "";
}

async function runFakePiWithToolOptions(
  options: Pick<PiRunOptions, "runtimeTools" | "customTools">,
) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-source-"));
  const piExecutable = path.join(workspace, "fake-pi.sh");
  try {
    await Bun.write(piExecutable, "#!/bin/sh\nprintenv\nprintf 'ARGS=%s\\n' \"$*\"\n");
    await chmod(piExecutable, 0o755);
    return await runPi({
      workspace,
      piExecutable,
      prompt: "Review this diff.",
      ...deepseekRunOptions(),
      ...options,
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function deepseekRunOptions(
  providerPatch: Partial<PiRunOptions["provider"]> = {},
): Pick<PiRunOptions, "env" | "provider"> {
  return {
    env: {
      DEEPSEEK_API_KEY: "provided-key",
      PATH: process.env.PATH,
    },
    provider: {
      id: "deepseek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
      thinking: "high",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      ...providerPatch,
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function passthroughSchema() {
  return {
    parse(value: unknown) {
      return value;
    },
  };
}

async function chmodTree(target: string, mode: number): Promise<void> {
  await chmod(target, mode);
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(target, entry.name);
    await chmod(entryPath, mode);
    if (entry.isDirectory()) {
      await chmodTree(entryPath, mode);
    }
  }
}
