import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { access, chmod, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cliPackage from "../../package.json" with { type: "json" };
import { publishRunBundleMetadata, runMain } from "../runner.js";
import { containedSkillFilePath, readBundledSkillCatalog } from "../skill-catalog.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliProjectDir = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliProjectDir, "../..");
const cliPath = path.join(cliProjectDir, "src", "main.ts");

describe("pipr CLI", () => {
  it("publishes finalized run metadata only for GitHub", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-run-metadata-"));
    const outputPath = path.join(workspace, "github-output.txt");
    await Bun.write(outputPath, "");
    const originalOutput = process.env.GITHUB_OUTPUT;
    process.env.GITHUB_OUTPUT = outputPath;
    try {
      await publishRunBundleMetadata(
        {
          executionId: "0123456789abcdef0123456789abcdef",
          directory: path.join(workspace, "bundle;%]\n"),
          kind: "review",
          outcome: "succeeded",
          protection: "age",
          repository: { host: "bitbucket", repository: "pipr", changeNumber: 42 },
        },
        {
          rootDir: workspace,
          env: { GITHUB_ACTIONS: "true", TF_BUILD: "True", BITBUCKET_BUILD_NUMBER: "7" },
        },
      );
      const output = await Bun.file(outputPath).text();
      expect(parseGitHubOutputRecords(output)).toEqual({
        "execution-id": "0123456789abcdef0123456789abcdef",
        "run-bundle-path": "bundle;%]\n",
        "run-artifact-name": "pipr-run-v1-age-pr-42-0123456789abcdef0123456789abcdef",
      });

      await Bun.write(outputPath, "");
      await publishRunBundleMetadata(
        {
          executionId: "fedcba9876543210fedcba9876543210",
          directory: path.join(workspace, "bundle"),
          kind: "review",
          outcome: "succeeded",
        },
        { rootDir: workspace, env: {} },
      );
      expect(await Bun.file(outputPath).text()).toBe("");
    } finally {
      if (originalOutput === undefined) delete process.env.GITHUB_OUTPUT;
      else process.env.GITHUB_OUTPUT = originalOutput;
      await removeWorkspace(workspace);
    }
  });

  it("maps update-notice policy before command execution", async () => {
    const requests: string[] = [];
    const notices: string[] = [];
    const output = await captureConsole(async () => {
      await runMain({
        argv: ["bun", "pipr", "version"],
        env: {},
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
        writeUpdateNotice: (message) => notices.push(message),
      });
    });

    expect(requests).toEqual(["https://api.github.com/repos/somus/pipr/releases/latest"]);
    expect(notices[0]).toContain("pipr 9.9.9 is available");
    expect(output.stdout).toBe(`${cliPackage.version}\n`);

    requests.length = 0;
    notices.length = 0;
    await expect(
      runMain({
        argv: ["bun", "pipr", "update"],
        env: {},
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
        writeUpdateNotice: (message) => notices.push(message),
      }),
    ).rejects.toThrow("compiled GitHub Release binaries");
    expect(requests).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("keeps bundled skill paths inside their target directory", () => {
    const root = path.resolve(os.tmpdir(), "pipr-skill-root");
    expect(containedSkillFilePath(root, "references/recipes.md")).toBe(
      path.join(root, "references", "recipes.md"),
    );
    expect(() => containedSkillFilePath(root, "../escape.md")).toThrow(
      "Bundled skill file path escapes the skill directory",
    );
  });

  it("uses injected cwd and env for check and inspect", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-context-"));
    try {
      await initializeWorkspace(workspace);
      const check = await runInProcess(
        ["check", "--require-env"],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace,
      );
      const inspect = await runInProcess(["inspect"], {}, workspace);

      expect(check.exitCode, check.stderr).toBe(0);
      expect(check.stdout).toContain(`valid: ${path.join(workspace, ".pipr", "config.ts")}`);
      expect(inspect.exitCode, inspect.stderr).toBe(0);
      expect(inspect.stdout).toContain("models");
      expect(inspect.stdout).toContain("core/pr-review");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("uses injected cwd for relative webhook status paths", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-webhook-context-"));
    const databasePath = path.join(workspace, ".pipr", "webhooks.sqlite");
    try {
      await mkdir(path.dirname(databasePath), { recursive: true });
      const database = new Database(databasePath, { create: true, strict: true });
      database.exec(`
        CREATE TABLE webhook_deliveries (
          id TEXT PRIMARY KEY, host TEXT NOT NULL, payload TEXT,
          status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      database.close();

      const result = await runInProcess(["webhook", "status", "--json"], {}, workspace);

      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ formatVersion: 1, deliveries: [] });
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("uses injected cwd and env for local review", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      const result = await runInProcess(
        ["review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("No findings.");
      expect(result.stderr).toContain("pipr local review complete");
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(2);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("uses injected cwd and env for host-run with a relative event path", async () => {
    const result = await runHostRunWithGitWorkspace({ inProcess: true });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("pipr dry-run completed for change #1");
    expect(result.piCalled).toBe(false);
  });

  it("uses injected cwd and env for runs commands", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-runs-context-"));
    const home = path.join(workspace, "home");
    try {
      const result = await runInProcess(["runs", "keygen"], { HOME: home }, workspace);
      const identityPath = result.stdout.match(/^Identity: (.+)$/m)?.[1];

      expect(result.exitCode, result.stderr).toBe(0);
      expect(identityPath).toStartWith(home);
      expect(await fileExists(identityPath ?? "")).toBe(true);
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("starts and exposes no-args, help, and version process boundaries", async () => {
    const noArgs = await runCli([]);
    const help = await runCli(["--help"]);
    const version = await runCli(["--version"]);

    expect(noArgs.exitCode).toBe(0);
    expect(help.exitCode).toBe(0);
    expect(noArgs.stdout).toContain("Usage: pipr");
    expect(help.stdout).toContain("Start here (for AI agents):");
    expect(version.stdout).toBe(`${cliPackage.version}\n`);
  });

  it("keeps local fatal exit and terminal sanitization at the process boundary", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-fatal-"));
    try {
      await mkdir(path.join(workspace, ".pipr"));
      await Bun.write(
        path.join(workspace, ".pipr", "config.ts"),
        'throw new Error("bad \\u001b]0;evil\\u0007\\nnext \\u001b[31mred\\u001b[0m\\rline");\n',
      );
      const result = await runCli(["check"], {}, workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("error: bad \nnext redline");
      expect(result.stderr).not.toContain("\u001b");
      expect(result.stderr).not.toContain("::error::");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("keeps GitHub Actions fatal formatting at the process boundary", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-action-fatal-"));
    const githubOutputPath = path.join(workspace, "github-output.txt");
    try {
      await Bun.write(githubOutputPath, "");
      const result = await runCli(
        ["check"],
        { GITHUB_ACTIONS: "true", GITHUB_OUTPUT: githubOutputPath },
        workspace,
      );
      const output = await Bun.file(githubOutputPath).text();

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("::error::");
      expect(output).toContain('"formatVersion":2');
      expect(output).toContain('"kind":"error"');
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("loads provider credentials from .env at Bun startup", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      await Bun.write(path.join(workspace.rootDir, ".env"), "DEEPSEEK_API_KEY=provider-key\n");
      const result = await runCli(
        ["review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        {},
        workspace.rootDir,
      );

      expect(result.exitCode, result.stderr).toBe(0);
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(2);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("materializes the skill cache safely across concurrent processes", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          runCliAsync(["skill", "path"], { PIPR_SKILL_CACHE_DIR: cacheDir }),
        ),
      );
      const paths = new Set(results.map((result) => result.stdout.trim()));

      expect(results.every((result) => result.exitCode === 0)).toBe(true);
      expect(paths.size).toBe(1);
      expect(await fileExists(path.join([...paths][0] ?? "", "SKILL.md"))).toBe(true);
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("rejects unexpected files from the bundled skill catalog", async () => {
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-skills-root-"));
    try {
      const skillDir = path.join(skillsRoot, "pipr-setup");
      await mkdir(path.join(skillDir, "references"), { recursive: true });
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\ndescription: Test skill\n---\n");
      await Bun.write(path.join(skillDir, "references/config-patterns.md"), "patterns\n");
      await Bun.write(path.join(skillDir, "references/recipes.md"), "recipes\n");
      await Bun.write(path.join(skillDir, "notes.txt"), "unexpected\n");

      await expect(readBundledSkillCatalog(skillsRoot)).rejects.toThrow(
        "pipr-setup bundled files must match the release allowlist",
      );
    } finally {
      await removeWorkspace(skillsRoot);
    }
  });

  it("replaces stale skill-cache symlinks without following them", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    const staleSkillDir = path.join(cacheDir, cliPackage.version, "pipr-setup");
    const victimPath = path.join(cacheDir, "victim.txt");
    try {
      await mkdir(staleSkillDir, { recursive: true });
      await Bun.write(victimPath, "do not overwrite\n");
      await symlink(victimPath, path.join(staleSkillDir, "SKILL.md"));

      const result = await runCli(["skill", "path"], { PIPR_SKILL_CACHE_DIR: cacheDir });
      const skillPath = result.stdout.trim();

      expect(result.exitCode, result.stderr).toBe(0);
      expect(await Bun.file(victimPath).text()).toBe("do not overwrite\n");
      expect((await lstat(path.join(skillPath, "SKILL.md"))).isSymbolicLink()).toBe(false);
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("rejects self-update when running from source", async () => {
    const result = await runCli(["update"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("pipr update only supports compiled GitHub Release binaries");
    expect(result.stderr).toContain("npm install -g @usepipr/cli@latest");
  });

  it("initializes and checks a TypeScript config through the process boundary", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-init-"));
    try {
      const init = await runCli(["init"], {}, workspace);
      const check = await runCli(["check"], {}, workspace);

      expect(init.exitCode, init.stderr).toBe(0);
      expect(init.stdout).toMatch(/created \d+ file\(s\)/);
      expect(check.exitCode, check.stderr).toBe(0);
      expect(check.stdout).toContain("valid:");
      expect(await fileExists(path.join(workspace, ".pipr", "config.ts"))).toBe(true);
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("prints versioned local-review JSON through the process boundary", async () => {
    const workspace = await createLocalReviewWorkspace({ findings: true });
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
      expect(result.exitCode, result.stderr).toBe(0);
      const json = JSON.parse(result.stdout) as {
        formatVersion: number;
        kind: string;
        inlineFindings: unknown[];
        droppedFindings: unknown[];
        publication: { state: string };
      };

      expect(json.formatVersion).toBe(2);
      expect(json.kind).toBe("review");
      expect(json.inlineFindings.length).toBeGreaterThan(0);
      expect(Array.isArray(json.droppedFindings)).toBe(true);
      expect(json.publication).toEqual({ state: "disabled" });
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  }, 30_000);

  it("runs a hosted GitHub Action event through the process boundary", async () => {
    const result = await runHostRunWithGitWorkspace({ githubActions: true });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("::group::pipr host run");
    expect(result.stdout).toContain('"event":"host run start"');
    expect(result.stdout).toContain("PIPR_DRY_RUN=1");
    expect(result.piCalled).toBe(false);
  });
});

function parseGitHubOutputRecords(source: string): Record<string, string> {
  const lines = source.split("\n");
  const records: Record<string, string> = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(?<name>[^<]+)<<(?<delimiter>.+)$/.exec(lines[index] ?? "");
    if (!match?.groups) continue;
    const values: string[] = [];
    index += 1;
    while (index < lines.length && lines[index] !== match.groups.delimiter) {
      values.push(lines[index] ?? "");
      index += 1;
    }
    records[match.groups.name ?? ""] = values.join("\n");
  }
  return records;
}

async function initializeWorkspace(workspace: string): Promise<void> {
  const result = await runCli(["init"], {}, workspace);
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

async function createLocalReviewWorkspace(
  options: { findings?: boolean } = {},
): Promise<{ rootDir: string; baseSha: string; headSha: string; piExecutable: string }> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-review-"));
  await initializeGitRepository(rootDir);
  await initializeWorkspace(rootDir);
  await mkdir(path.join(rootDir, "src"));
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 1;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "base"], rootDir);
  const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 2;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "head"], rootDir);
  const headSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  const piExecutable = path.join(rootDir, "fake-pi.ts");
  await Bun.write(
    piExecutable,
    options.findings ? reviewFindingsExecutable() : noFindingsExecutable(),
  );
  await chmod(piExecutable, 0o755);
  return { rootDir, baseSha, headSha, piExecutable };
}

async function runHostRunWithGitWorkspace(options: {
  inProcess?: boolean;
  githubActions?: boolean;
}): Promise<{ exitCode: number; stdout: string; stderr: string; piCalled: boolean }> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-host-"));
  try {
    await initializeGitRepository(workspace);
    await initializeWorkspace(workspace);
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
    const env = {
      DEEPSEEK_API_KEY: "provider-key",
      PIPR_DRY_RUN: "1",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_WORKSPACE: workspace,
      ...(options.githubActions ? { GITHUB_ACTIONS: "true" } : {}),
    };
    const args = [
      "host-run",
      "--host",
      "github",
      "--event",
      options.inProcess ? path.basename(eventPath) : eventPath,
    ];
    const result = options.inProcess
      ? await runInProcess(args, env, workspace)
      : await runCli(args, env, workspace);
    return { ...result, piCalled: await fileExists(path.join(workspace, "pi-called")) };
  } finally {
    await removeWorkspace(workspace);
  }
}

async function initializeGitRepository(workspace: string): Promise<void> {
  await runCommand("git", ["init", "--initial-branch=main"], workspace);
  await runCommand("git", ["config", "user.name", "pipr test"], workspace);
  await runCommand("git", ["config", "user.email", "pipr@example.test"], workspace);
  await runCommand("git", ["config", "core.hooksPath", "/dev/null"], workspace);
  await runCommand("git", ["config", "commit.gpgsign", "false"], workspace);
}

function noFindingsExecutable(): string {
  return [
    "#!/usr/bin/env bun",
    'const callLog = import.meta.dir + "/pi-called";',
    'const previous = (await Bun.file(callLog).exists()) ? await Bun.file(callLog).text() : "";',
    'await Bun.write(callLog, previous + "1\\n");',
    'const promptArg = process.argv.at(-1) ?? "";',
    'const prompt = promptArg.startsWith("@") ? await Bun.file(promptArg.slice(1)).text() : promptArg;',
    'if (prompt.includes("Schema ID: core/inline-findings.")) console.log(JSON.stringify({ inlineFindings: [] }));',
    'else if (prompt.includes("Schema ID: core/summary.")) console.log(JSON.stringify({ body: "No findings." }));',
    'else console.log(JSON.stringify({ summary: { body: "No findings." }, inlineFindings: [] }));',
  ].join("\n");
}

function reviewFindingsExecutable(): string {
  return [
    "#!/usr/bin/env bun",
    'const promptArg = process.argv.at(-1) ?? "";',
    'const prompt = promptArg.startsWith("@") ? await Bun.file(promptArg.slice(1)).text() : promptArg;',
    'if (prompt.includes("Schema ID: core/summary.")) { console.log(JSON.stringify({ body: "One finding." })); process.exit(0); }',
    'const label = "\\nManifest:";',
    "const content = prompt.slice(prompt.indexOf(label) + label.length);",
    'const markers = ["\\n\\nCondensed manifest helper tools:", "\\n\\nInstructions:", "\\n\\nRun Instructions:", "\\n\\nPrompt:"]',
    "  .map((marker) => content.indexOf(marker)).filter((index) => index !== -1);",
    "const manifest = JSON.parse(content.slice(0, Math.min(...markers)).trim());",
    'const file = manifest.files.find((item) => item.path === "src/a.ts");',
    'const range = file.commentableRanges.find((item) => item.side === "RIGHT");',
    'const finding = { body: "Use the reviewed value.", path: range.path, rangeId: range.id, side: range.side, startLine: range.startLine, endLine: range.startLine };',
    'const inlineFindings = [finding, { ...finding, body: "Invalid location.", rangeId: "rng_missing" }];',
    'if (prompt.includes("Schema ID: core/inline-findings.")) console.log(JSON.stringify({ inlineFindings }));',
    'else console.log(JSON.stringify({ summary: { body: "One finding." }, inlineFindings }));',
  ].join("\n");
}

async function runInProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let error: unknown;
  const output = await captureConsole(async () => {
    try {
      await runMain({ argv: ["bun", "pipr", ...args], env: { ...minimalEnv(), ...env }, cwd });
    } catch (caught) {
      error = caught;
    }
  });
  return {
    exitCode: error === undefined ? 0 : 1,
    stdout: output.stdout,
    stderr: error === undefined ? output.stderr : `${output.stderr}${String(error)}\n`,
  };
}

async function captureConsole(
  run: () => Promise<void>,
): Promise<{ stdout: string; stderr: string }> {
  const originalLog = console.log;
  const originalError = console.error;
  const stdout: string[] = [];
  const stderr: string[] = [];
  console.log = (...values: unknown[]) => stdout.push(`${values.map(String).join(" ")}\n`);
  console.error = (...values: unknown[]) => stderr.push(`${values.map(String).join(" ")}\n`);
  try {
    await run();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { stdout: stdout.join(""), stderr: stderr.join("") };
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = Bun.spawnSync(["bun", cliPath, ...args], {
    cwd,
    env: { ...minimalEnv(), ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

async function runCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    env: { ...minimalEnv(), ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    result.exited,
    result.stdout ? new Response(result.stdout).text() : "",
    result.stderr ? new Response(result.stderr).text() : "",
  ]);
  return { exitCode, stdout, stderr };
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "BUN_INSTALL",
    "BUN_INSTALL_CACHE_DIR",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
    "USER",
  ]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.BUN_INSTALL_CACHE_DIR ??= path.join(repoRoot, "node_modules", ".cache", "pipr-bun-install");
  env.PIPR_INTERNAL_INIT_SDK_VERSION = `file:${path.join(repoRoot, "packages/sdk")}`;
  env.PIPR_UPDATE_NOTICE = "0";
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
  if (result.exitCode !== 0)
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  return stdout;
}

function pullRequestPayload(baseSha: string, headSha: string): unknown {
  return {
    action: "opened",
    number: 1,
    repository: { full_name: "local/pipr" },
    pull_request: {
      number: 1,
      base: { sha: baseSha, repo: { full_name: "local/pipr" } },
      head: { sha: headSha },
    },
  };
}

function fakeLatestReleaseFetch(version: string, requests: string[]): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    return url === "https://api.github.com/repos/somus/pipr/releases/latest"
      ? Response.json({ tag_name: `v${version}` })
      : new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function countLines(filePath: string): Promise<number> {
  if (!(await fileExists(filePath))) return 0;
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

async function removeWorkspace(workspace: string): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
}
