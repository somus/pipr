import { describe, expect, it } from "bun:test";
import { access, chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { embeddedSdkDeclaration, readSdkDeclarationModules } from "../release/sdk-declaration.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliProjectDir = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliProjectDir, "../..");
const cliPath = path.join(cliProjectDir, "src", "main.ts");

describe("pipr CLI", () => {
  it("prints TS-first subcommands", async () => {
    const result = await runCli(["--help"]);
    const action = await runCli(["action", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(action.exitCode).toBe(0);
    expect(result.stdout).toContain("init [options]");
    expect(result.stdout).toContain("check [options]");
    expect(result.stdout).toContain("inspect [options]");
    expect(result.stdout).toContain("review [options]");
    expect(result.stdout).not.toContain("run [options] <name>");
    const init = await runCli(["init", "--help"]);
    expect(init.stdout).toContain("--adapters <adapters>");
    expect(init.stdout).toContain("--recipe <recipe>");
    expect(init.stdout).toContain("--no-types");
    expect(init.stdout).toContain("--types-only");
    expect(init.stdout).toContain("github");
    expect(init.stdout).toContain("none");
    expect(init.stdout).toContain("multi-agent-review");
    expect(action.stdout).toContain("--config-dir <dir>");
    expect(action.stdout).not.toContain("--provider <name>");
  });

  it("requires an explicit base SHA for local review runs", async () => {
    const result = await runCli(["review"]);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("pipr review requires --base <sha>");
  });

  it("runs local review without GitHub publishing", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      const result = await runCli(
        ["review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("# Pipr Review");
      expect(result.stdout).toContain("No findings.");
      expect(result.stdout).not.toContain("<!-- pipr:main-comment ");
      expect(result.stderr).toContain("pipr local review start");
      expect(result.stderr).toContain("pipr task runtime start");
      expect(result.stderr).toContain("pipr local review complete");
      expect(result.stderr).not.toContain('{"level":');
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("reviews unstaged working tree changes when local head is omitted", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      await Bun.write(path.join(workspace.rootDir, "src/a.ts"), "export const value = 3;\n");

      const result = await runCli(
        ["review", "--base", workspace.headSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("diffTarget=working-tree");
      expect(result.stderr).toContain("pipr diff manifest");
      expect(result.stderr).toContain("files=1");
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("prints local review JSON when requested", async () => {
    const workspace = await createLocalReviewWorkspace({ taskLog: true });
    try {
      const result = await runCli(
        [
          "review",
          "--base",
          workspace.baseSha,
          "--pi-executable",
          workspace.piExecutable,
          "--json",
        ],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("pipr local review start");
      expect(result.stderr).toContain("running local review");
      expect(result.stderr).toContain("pipr local review complete");
      expect(result.stderr).not.toContain('{"level":');
      const json = JSON.parse(result.stdout) as {
        kind: string;
        mainComment: string;
        inlineFindings: unknown[];
        taskChecks: unknown[];
      };
      expect(json.kind).toBe("review");
      expect(json.mainComment).toContain("<!-- pipr:main-comment ");
      expect(json.mainComment).toContain("No findings.");
      expect(json.inlineFindings).toEqual([]);
      expect(json.taskChecks).toEqual([{ taskName: "review", conclusion: "success" }]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("loads provider env from .env for local review", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      await Bun.write(path.join(workspace.rootDir, ".env"), "DEEPSEEK_API_KEY=provider-key\n");

      const result = await runCli(
        ["review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        {},
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("does not expose removed run command", async () => {
    const result = await runCli(["run"]);

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("unknown command 'run'");
  });

  it("initializes and checks the TypeScript config", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await runInitAndCheck(workspace, ["init"]);

      expect(await Bun.file(path.join(workspace, ".pipr", "config.ts")).text()).toContain(
        "pipr.review",
      );
      expect(
        await Bun.file(path.join(workspace, ".github", "workflows", "pipr.yml")).text(),
      ).toContain("uses: somus/pipr@v0.1.2"); // x-release-please-version
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("initializes config files without adapter files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await runInit(workspace, ["init", "--adapters", "none"]);

      expect(await fileExists(path.join(workspace, ".github", "workflows", "pipr.yml"))).toBe(
        false,
      );
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("initializes config files without local type support", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await runInit(workspace, ["init", "--adapters", "none", "--no-types"]);

      expect(await fileExists(path.join(workspace, ".pipr", "tsconfig.json"))).toBe(false);
      expect(await fileExists(path.join(workspace, ".pipr", "types"))).toBe(false);
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("adds local type support after a no-types init", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const init = await runCli(["init", "--adapters", "none", "--no-types"], {}, workspace);
      const types = await runCli(["init", "--types-only"], {}, workspace);
      const second = await runCli(["init", "--types-only"], {}, workspace);

      expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
      expect(types.exitCode, `${types.stdout}\n${types.stderr}`).toBe(0);
      expect(types.stdout).toMatch(/created \d+ file\(s\)/);
      expect(second.exitCode, `${second.stdout}\n${second.stderr}`).toBe(0);
      expect(second.stdout).toContain("created 0 file(s)");
      expect(await fileExists(path.join(workspace, ".pipr", "tsconfig.json"))).toBe(true);
      expect(await fileExists(path.join(workspace, ".pipr", "types", "pipr-sdk.d.ts"))).toBe(true);
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("initializes a selected starter recipe", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const init = await runCli(
        ["init", "--adapters", "none", "--recipe", "plugin-tool-review"],
        {},
        workspace,
      );
      const inspect = await runCli(["inspect"], {}, workspace);

      expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
      expect(init.stdout).toMatch(/created \d+ file\(s\)/);
      expect(inspect.exitCode, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
      expect(inspect.stdout).toContain("r2_memory_search");
      expect(await Bun.file(path.join(workspace, ".pipr", "config.ts")).text()).toContain(
        "r2MemoryPlugin",
      );
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("rejects unsupported init adapters", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const unsupported = await runCli(["init", "--adapters", "gitlab"], {}, workspace);
      const mixedNone = await runCli(["init", "--adapters", "none,github"], {}, workspace);
      const unsupportedRecipe = await runCli(
        ["init", "--adapters", "none", "--recipe", "missing"],
        {},
        workspace,
      );
      const typesWithRecipe = await runCli(
        ["init", "--types-only", "--recipe", "default-review"],
        {},
        workspace,
      );
      const typesWithAdapters = await runCli(
        ["init", "--types-only", "--adapters", "none"],
        {},
        workspace,
      );
      const typesWithNoTypes = await runCli(["init", "--types-only", "--no-types"], {}, workspace);

      expect(unsupported.exitCode).toBe(1);
      expect(`${unsupported.stdout}\n${unsupported.stderr}`).toContain(
        "Unsupported pipr init adapter 'gitlab'. Supported adapters: github",
      );
      expect(mixedNone.exitCode).toBe(1);
      expect(`${mixedNone.stdout}\n${mixedNone.stderr}`).toContain(
        "Adapter 'none' cannot be mixed with other init adapters",
      );
      expect(unsupportedRecipe.exitCode).toBe(1);
      expect(`${unsupportedRecipe.stdout}\n${unsupportedRecipe.stderr}`).toContain(
        "Unsupported pipr init recipe 'missing'. Supported recipes:",
      );
      expect(typesWithRecipe.exitCode).toBe(1);
      expect(`${typesWithRecipe.stdout}\n${typesWithRecipe.stderr}`).toContain(
        "--types-only cannot be combined with --recipe",
      );
      expect(typesWithAdapters.exitCode).toBe(1);
      expect(`${typesWithAdapters.stdout}\n${typesWithAdapters.stderr}`).toContain(
        "--types-only cannot be combined with --adapters",
      );
      expect(typesWithNoTypes.exitCode).toBe(1);
      expect(`${typesWithNoTypes.stdout}\n${typesWithNoTypes.stderr}`).toContain(
        "--types-only cannot be combined with --no-types",
      );
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("checks the repo root dogfood config", async () => {
    const result = await runCli(["check"], {}, repoRoot);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("valid:");
    expect(result.stdout).toContain(".pipr/config.ts");
    expect(await listFiles(path.join(repoRoot, ".pipr"))).toContain("config.ts");
  });

  it("refuses init conflicts unless force is explicit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await mkdir(path.join(workspace, ".pipr"));
      await Bun.write(path.join(workspace, ".pipr", "config.ts"), "custom: true\n");

      const conflict = await runCli(["init"], {}, workspace);
      const forced = await runCli(["init", "--force"], {}, workspace);

      expect(conflict.exitCode).toBe(1);
      expect(`${conflict.stdout}\n${conflict.stderr}`).toContain(
        "Use --force to replace existing .pipr files",
      );
      expect(forced.exitCode).toBe(0);
      expect(forced.stdout).toContain("overwrote 1");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("runs action dry-run without requiring provider env", async () => {
    const result = await runActionWithGitWorkspace({
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::group::pipr action");
    expect(result.stdout).toContain('::notice::{"level":"notice"');
    expect(result.stdout).toContain('"event":"action start"');
    expect(result.stdout).toContain("pipr loaded change #1 for local/pipr");
    expect(result.stdout).toContain("PIPR_DRY_RUN=1");
    expect(result.piCalled).toBe(false);
  });

  it("fails action dry-run before model work when config is missing", async () => {
    const result = await runActionWithGitWorkspace({
      initConfig: false,
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain("config.ts is required at base commit");
    expect(result.piCalled).toBe(false);
  });

  it("inspects the TS runtime plan after config validation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await initWorkspaceConfig(workspace);
      const inspect = await runCli(["inspect"], {}, workspace);

      expect(inspect.exitCode).toBe(0);
      expect(inspect.stdout).toContain("models");
      expect(inspect.stdout).toContain("agents");
      expect(inspect.stdout).toContain("tasks");
      expect(inspect.stdout).toContain("events");
      expect(inspect.stdout).toContain("commands");
      expect(inspect.stdout).not.toContain("locals");
      expect(inspect.stdout).toContain("tools");
      expect(inspect.stdout).toContain("schemas");
      expect(inspect.stdout).toContain("core/pr-review");
      expect(inspect.stdout).toContain("core/summary");
      expect(inspect.stdout).not.toContain("core/review-candidates");
      expect(inspect.stdout).not.toContain("core/consolidated-review");
      expect(inspect.stdout).toContain("deepseek");
      expect(inspect.stdout).toContain("@pipr review");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("embeds standalone SDK declarations for release init", async () => {
    const declaration = embeddedSdkDeclaration(await readSdkDeclarationModules(repoRoot));

    expect(declaration).toContain('declare module "@usepipr/sdk"');
    expect(declaration).toContain("const z: {");
    expect(declaration).toContain("type ZodSchema<T>");
    expect(declaration).not.toContain('from "zod"');
    expect(declaration).not.toContain("z.ZodType");
  });
});

async function runActionWithGitWorkspace(options: {
  env?: NodeJS.ProcessEnv;
  initConfig?: boolean;
}): Promise<{
  exitCode: number;
  baseSha: string;
  headSha: string;
  piCalled: boolean;
  piCallCount: number;
  stdout: string;
  stderr: string;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  try {
    await runCommand("git", ["init", "--initial-branch=main"], workspace);
    await runCommand("git", ["config", "user.name", "pipr test"], workspace);
    await runCommand("git", ["config", "user.email", "pipr@example.test"], workspace);
    await runCommand("git", ["config", "core.hooksPath", "/dev/null"], workspace);
    await runCommand("git", ["config", "commit.gpgsign", "false"], workspace);
    if (options.initConfig !== false) {
      await initWorkspaceConfig(workspace);
    }
    await mkdir(path.join(workspace, "src"));
    await Bun.write(path.join(workspace, "src/a.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "base"], workspace);
    const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    await Bun.write(path.join(workspace, "src/a.ts"), "export const value = 2;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "head"], workspace);
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    const eventPath = path.join(workspace, "event.json");
    const githubOutputPath = path.join(workspace, "github-output.txt");
    await Bun.write(eventPath, JSON.stringify(pullRequestPayload(baseSha, headSha)));
    await Bun.write(githubOutputPath, "");

    const result = await runCli(["action"], {
      DEEPSEEK_API_KEY: "provider-key",
      ...options.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_WORKSPACE: workspace,
    });
    return {
      ...result,
      baseSha,
      headSha,
      piCalled: await fileExists(path.join(workspace, "pi-called")),
      piCallCount: await countLines(path.join(workspace, "pi-called")),
    };
  } finally {
    await removeWorkspace(workspace);
  }
}

async function createLocalReviewWorkspace(options: { taskLog?: boolean } = {}): Promise<{
  rootDir: string;
  baseSha: string;
  headSha: string;
  piExecutable: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  await runCommand("git", ["init", "--initial-branch=main"], rootDir);
  await runCommand("git", ["config", "user.name", "pipr test"], rootDir);
  await runCommand("git", ["config", "user.email", "pipr@example.test"], rootDir);
  await runCommand("git", ["config", "core.hooksPath", "/dev/null"], rootDir);
  await runCommand("git", ["config", "commit.gpgsign", "false"], rootDir);
  await initWorkspaceConfig(rootDir);
  if (options.taskLog) {
    await Bun.write(path.join(rootDir, ".pipr", "config.ts"), localReviewConfigWithTaskLog());
  }
  await mkdir(path.join(rootDir, "src"));
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 1;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "base"], rootDir);
  const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 2;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "head"], rootDir);
  const headSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await Bun.write(
    piExecutable,
    ["#!/bin/sh", 'printf "1\\n" >> "$(dirname "$0")/pi-called"', noFindingsJsonCommand()].join(
      "\n",
    ),
  );
  await chmod(piExecutable, 0o755);
  return { rootDir, baseSha, headSha, piExecutable };
}

function localReviewConfigWithTaskLog(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-v4-pro",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const reviewer = pipr.agent({",
    '    name: "reviewer",',
    "    model,",
    '    instructions: "Review this change.",',
    "    output: pipr.schemas.review,",
    '    prompt: () => "Review.",',
    "  });",
    "  const task = pipr.task({",
    '    name: "review",',
    "    async run(ctx) {",
    '      ctx.log.info("running local review");',
    "      const manifest = await ctx.change.diffManifest({ compressed: true });",
    "      const result = await ctx.pi.run(reviewer, { manifest });",
    "      await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });",
    "    },",
    "  });",
    '  pipr.on.changeRequest({ actions: ["opened", "updated"], task });',
    "});",
  ].join("\n");
}

function noFindingsJsonCommand(): string {
  return 'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'';
}

async function countLines(filePath: string): Promise<number> {
  if (!(await fileExists(filePath))) {
    return 0;
  }
  return (await Bun.file(filePath).text()).split("\n").filter(Boolean).length;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initWorkspaceConfig(workspace: string): Promise<void> {
  const result = await runCli(["init"], {}, workspace);
  if (result.exitCode !== 0) {
    throw new Error(`pipr init failed: ${result.stderr || result.stdout}`);
  }
}

async function runInitAndCheck(
  workspace: string,
  initArgs: string[],
): Promise<{
  init: Awaited<ReturnType<typeof runCli>>;
  check: Awaited<ReturnType<typeof runCli>>;
}> {
  const init = await runInit(workspace, initArgs);
  const check = await runCli(["check"], {}, workspace);
  expect(check.exitCode, `${check.stdout}\n${check.stderr}`).toBe(0);
  expect(check.stdout).toContain("valid:");
  return { init, check };
}

async function runInit(
  workspace: string,
  initArgs: string[],
): Promise<Awaited<ReturnType<typeof runCli>>> {
  const init = await runCli(initArgs, {}, workspace);
  expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
  expect(init.stdout).toMatch(/created \d+ file\(s\)/);
  return init;
}

async function removeWorkspace(workspace: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = Bun.spawnSync(["bun", cliPath, ...args], {
    cwd,
    env: {
      ...minimalEnv(),
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["BUN_INSTALL", "HOME", "LANG", "PATH", "TMPDIR", "USER"]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: minimalEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function pullRequestPayload(baseSha = "base", headSha = "head"): unknown {
  return {
    action: "opened",
    number: 1,
    repository: {
      full_name: "local/pipr",
    },
    pull_request: {
      number: 1,
      base: {
        sha: baseSha,
        repo: {
          full_name: "local/pipr",
        },
      },
      head: {
        sha: headSha,
      },
    },
  };
}

async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(rootDir, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        return await listFiles(rootDir, relativePath);
      }
      return [relativePath.split(path.sep).join("/")];
    }),
  );
  return files.flat().sort();
}
