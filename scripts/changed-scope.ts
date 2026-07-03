#!/usr/bin/env bun
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

type Scope = "docker" | "docs";

const scope = process.argv[2] as Scope | undefined;
assert(scope === "docs" || scope === "docker", "usage: scripts/changed-scope.ts <docs|docker>");

const eventName = env("EVENT_NAME");
const base = eventName === "pull_request" ? env("PR_BASE_SHA") : env("PUSH_BEFORE_SHA");
const head = eventName === "pull_request" ? env("PR_HEAD_SHA") : env("HEAD_SHA");

let changed = true;
if (base && !/^0+$/.test(base)) {
  changed = gitChangedFiles(base, head).some((file) => matchesScope(scope, file));
}

await writeOutput("changed", String(changed));

function gitChangedFiles(base: string, head: string): string[] {
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

function matchesScope(selectedScope: Scope, file: string): boolean {
  if (selectedScope === "docs") {
    return (
      file.startsWith("apps/docs/") ||
      file.startsWith("docs/") ||
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

  if (
    file.includes("/tests/") ||
    file.endsWith(".test.ts") ||
    file === "packages/e2e/assertions.ts"
  ) {
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
    file.startsWith("packages/cli/") ||
    file.startsWith("packages/runtime/") ||
    file.startsWith("packages/sdk/") ||
    file.startsWith("packages/e2e/")
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
