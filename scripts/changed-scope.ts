#!/usr/bin/env bun
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

type Scope = "docker" | "docs";

const scope = process.argv[2] as Scope | undefined;
assert(scope === "docs" || scope === "docker", "usage: scripts/changed-scope.ts <docs|docker>");

const eventName = env("EVENT_NAME");
const changeRange = getChangeRange(eventName);

let changed = true;
if (changeRange && !/^0+$/.test(changeRange.base)) {
  const changedFiles = gitChangedFiles(changeRange.base, changeRange.head);
  changed = changedFiles === undefined || changedFiles.some((file) => matchesScope(scope, file));
}

await writeOutput("changed", String(changed));

function getChangeRange(eventName: string): { base: string; head: string } | undefined {
  if (!eventName) {
    return undefined;
  }
  if (eventName === "pull_request") {
    return {
      base: requiredEnv("PR_BASE_SHA", eventName),
      head: requiredEnv("PR_HEAD_SHA", eventName),
    };
  }
  if (eventName === "push") {
    return {
      base: requiredEnv("PUSH_BEFORE_SHA", eventName),
      head: requiredEnv("HEAD_SHA", eventName),
    };
  }
  return undefined;
}

function requiredEnv(name: string, eventName: string): string {
  const value = env(name);
  if (!value) {
    throw new Error(`changed-scope: ${name} is required for ${eventName} events`);
  }
  return value;
}

function gitChangedFiles(base: string, head: string): string[] | undefined {
  if (!gitCommitExists(base) || !gitCommitExists(head)) {
    return undefined;
  }
  const result = Bun.spawnSync(["git", "diff", "--name-only", base, head], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || "git diff failed");
  }
  return result.stdout
    .toString()
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
}

function gitCommitExists(sha: string): boolean {
  return (
    Bun.spawnSync(["git", "cat-file", "-e", `${sha}^{commit}`], {
      stderr: "ignore",
      stdout: "ignore",
    }).exitCode === 0
  );
}

function matchesScope(selectedScope: Scope, file: string): boolean {
  if (selectedScope === "docs") {
    return (
      file.startsWith("apps/docs/") ||
      file.startsWith("docs/") ||
      file === "Dockerfile.docs" ||
      file === "install.sh" ||
      file === "scripts/docs-docker-e2e.ts" ||
      file.startsWith("packages/sdk/src/") ||
      file === "packages/sdk/tsconfig.json" ||
      file === "packages/runtime/src/config/recipes.ts" ||
      file.startsWith("packages/runtime/src/config/recipes/") ||
      file === "packages/runtime/src/config/official-github-workflow.ts" ||
      file === "packages/runtime/src/internal/docs.ts" ||
      file === "packages/runtime/package.json" ||
      file.endsWith(".md") ||
      [
        "package.json",
        "bun.lock",
        "turbo.json",
        "biome.json",
        ".fallowrc.json",
        ".github/workflows/ci.yml",
      ].includes(file) ||
      /^tsconfig.*\.json$/.test(file)
    );
  }

  if (file.includes("/tests/") || file.endsWith(".test.ts")) {
    return false;
  }

  return (
    [
      "Dockerfile",
      "action.yml",
      "package.json",
      "bun.lock",
      "turbo.json",
      "mise.toml",
      ".dockerignore",
      ".github/workflows/ci.yml",
    ].includes(file) ||
    file === "scripts/docker-e2e.ts" ||
    file.startsWith("skills/") ||
    file.startsWith("deploy/webhook/") ||
    file.startsWith("packages/cli/") ||
    file.startsWith("packages/runtime/") ||
    file.startsWith("packages/sdk/") ||
    file === "packages/e2e/package.json" ||
    file === "packages/e2e/action-fixture.ts" ||
    file === "packages/e2e/action-metadata.ts" ||
    file === "packages/e2e/action-run-plan.ts" ||
    file === "packages/e2e/assertions.ts" ||
    file === "packages/e2e/check.ts" ||
    file === "packages/e2e/container-check.ts" ||
    file === "packages/e2e/docker-e2e-plan.ts" ||
    file === "packages/e2e/fake-pi" ||
    file === "packages/e2e/pi-contract.ts" ||
    file === "packages/e2e/run.ts" ||
    file === "packages/e2e/scenarios.ts" ||
    file === "packages/e2e/webhook-fetch-mock.ts" ||
    file === "packages/e2e/webhook-health-fixture.ts"
  );
}

function env(name: string): string {
  return Bun.env[name] ?? "";
}

async function writeOutput(name: string, value: string): Promise<void> {
  const outputPath = Bun.env.GITHUB_OUTPUT;
  if (!outputPath) {
    console.log(`${name}=${value}`);
    return;
  }
  await appendFile(outputPath, `${name}=${value}\n`);
}
