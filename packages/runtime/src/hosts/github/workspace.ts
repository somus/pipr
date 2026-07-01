import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import type { ChangeRequestEventContext } from "../../types.js";

export function ensureGitHubWorkspaceSafeDirectory(options: {
  rootDir: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = options.env ?? process.env;
  if (env.GITHUB_ACTIONS !== "true") {
    return;
  }
  const workspace = env.GITHUB_WORKSPACE ?? options.rootDir;
  installSafeDirectoryEnv(workspace, env);
  const gitHome = gitGlobalConfigHome(env);
  process.env.HOME = gitHome;
  Bun.env.HOME = gitHome;
  const result = Bun.spawnSync(
    ["git", "config", "--global", "--add", "safe.directory", workspace],
    {
      env: { ...process.env, ...env, HOME: gitHome },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `git safe.directory setup failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
    );
  }
}

function installSafeDirectoryEnv(workspace: string, env: NodeJS.ProcessEnv): void {
  const index = gitConfigEnvCount(env);
  syncExistingGitConfigEnv(env, index);
  setEnv("GIT_CONFIG_COUNT", String(index + 1), env);
  setEnv(`GIT_CONFIG_KEY_${index}`, "safe.directory", env);
  setEnv(`GIT_CONFIG_VALUE_${index}`, workspace, env);
}

function syncExistingGitConfigEnv(env: NodeJS.ProcessEnv, count: number): void {
  for (let index = 0; index < count; index += 1) {
    copyEnv(`GIT_CONFIG_KEY_${index}`, env);
    copyEnv(`GIT_CONFIG_VALUE_${index}`, env);
  }
}

function copyEnv(key: string, env: NodeJS.ProcessEnv): void {
  const value = env[key] ?? process.env[key] ?? Bun.env[key];
  if (value !== undefined) {
    setEnv(key, value, env);
  }
}

function setEnv(key: string, value: string, env: NodeJS.ProcessEnv): void {
  env[key] = value;
  process.env[key] = value;
  Bun.env[key] = value;
}

function gitConfigEnvCount(env: NodeJS.ProcessEnv): number {
  const count = Number.parseInt(
    env.GIT_CONFIG_COUNT ?? process.env.GIT_CONFIG_COUNT ?? Bun.env.GIT_CONFIG_COUNT ?? "0",
    10,
  );
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function gitGlobalConfigHome(env: NodeJS.ProcessEnv): string {
  if (existsSync("/home/bun")) {
    return "/home/bun";
  }
  const root = env.RUNNER_TEMP ?? env.TMPDIR ?? os.tmpdir();
  mkdirSync(root, { recursive: true });
  return root;
}

export function ensureGitHubHeadCheckout(options: {
  rootDir: string;
  change: ChangeRequestEventContext;
}): void {
  const headSha = options.change.change.head.sha;
  if (!hasGitCommit(options.rootDir, headSha)) {
    runGit(options.rootDir, [
      "fetch",
      "--no-tags",
      "--depth=1",
      "origin",
      `refs/pull/${options.change.change.number}/head`,
    ]);
  }
  if (runGit(options.rootDir, ["rev-parse", "HEAD"]).trim() !== headSha) {
    runGit(options.rootDir, ["checkout", "--detach", headSha]);
  }
}

function hasGitCommit(rootDir: string, sha: string): boolean {
  try {
    runGit(rootDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function runGit(rootDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: rootDir,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
}
