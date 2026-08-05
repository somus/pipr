#!/usr/bin/env bun
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";

type Scope = "docs" | "docs-browser" | "docs-container" | "docker" | "prompt";
type ScopeRules = {
  exact?: readonly string[];
  prefixes?: readonly string[];
  patterns?: readonly RegExp[];
};

const scopes = ["docs", "docs-browser", "docs-container", "docker", "prompt"] as const;
const scopeArgument = process.argv[2];
assert(
  scopes.includes(scopeArgument as Scope),
  `usage: scripts/changed-scope.ts <${scopes.join("|")}>`,
);
const scope = scopeArgument as Scope;

const sharedBuildMetadata = [
  ".github/workflows/ci.yml",
  "bun.lock",
  "mise.toml",
  "package.json",
  "scripts/changed-scope.ts",
  "tsconfig.base.json",
  "tsconfig.json",
  "turbo.json",
] as const;

const rules: Record<Scope, ScopeRules> = {
  docs: {
    exact: [
      ...sharedBuildMetadata,
      ".fallowrc.json",
      "biome.json",
      "packages/runtime/package.json",
      "packages/runtime/src/config/official-github-workflow.ts",
      "packages/runtime/src/config/recipes.ts",
      "packages/runtime/src/internal/docs.ts",
      "packages/sdk/tsconfig.json",
    ],
    prefixes: [
      "apps/docs/",
      "docs/",
      "packages/runtime/src/config/recipes/",
      "packages/sdk/src/",
      "skills/pipr-setup/",
    ],
    patterns: [/^[^/]+\.md$/],
  },
  "docs-browser": {
    exact: [
      ...sharedBuildMetadata,
      "apps/docs/package.json",
      "apps/docs/playwright.config.ts",
      "apps/docs/scripts/build.ts",
      "apps/docs/scripts/og-images.ts",
      "apps/docs/source.config.ts",
      "apps/docs/tsconfig.json",
      "apps/docs/turbo.json",
      "apps/docs/twoslash-config.ts",
      "apps/docs/vite.config.ts",
    ],
    prefixes: ["apps/docs/public/", "apps/docs/src/", "apps/docs/tests/browser/"],
  },
  "docs-container": {
    exact: [
      ...sharedBuildMetadata,
      ".dockerignore",
      "Dockerfile.docs",
      "apps/docs/nginx.conf",
      "install.sh",
      "scripts/docs-docker-e2e.ts",
    ],
    patterns: [/^(apps|packages)\/[^/]+\/package\.json$/],
  },
  docker: {
    exact: [
      ...sharedBuildMetadata,
      ".dockerignore",
      "Dockerfile",
      "action.yml",
      "packages/cli/src/main.ts",
      "packages/cli/src/runner.ts",
      "packages/runtime/src/host-run/adapter.ts",
      "packages/runtime/src/host-run/change-request-entry.ts",
      "packages/runtime/src/host-run/command-entry.ts",
      "packages/runtime/src/host-run/commands.ts",
      "packages/runtime/src/host-run/entry-dispatch.ts",
      "packages/runtime/src/host-run/git-project.ts",
      "packages/runtime/src/host-run/trusted-runtime.ts",
      "packages/runtime/src/hosts/git.ts",
      "packages/runtime/src/hosts/github/adapter.ts",
      "packages/runtime/src/hosts/selection.ts",
      "packages/runtime/src/pi/contract.ts",
      "packages/runtime/src/pi/provider.ts",
      "packages/runtime/src/pi/runner.ts",
      "scripts/docker-e2e.ts",
    ],
    prefixes: [
      "deploy/webhook/",
      "packages/e2e/",
      "packages/runtime/src/pi/runtime-tools",
      "skills/",
    ],
    patterns: [
      /^(apps|packages)\/[^/]+\/package\.json$/,
      /^packages\/runtime\/src\/hosts\/[^/]+\/(event|workspace)\.ts$/,
    ],
  },
  prompt: {
    exact: [
      ...sharedBuildMetadata,
      ".pipr/config.ts",
      "packages/runtime/src/config/recipes.ts",
      "packages/runtime/src/diff/manifest-projection.ts",
      "packages/runtime/src/diff/manifest-sharding.ts",
      "packages/runtime/src/review/contract.ts",
      "packages/runtime/src/review/inline-finding-limits.ts",
      "packages/runtime/src/review/range-validation.ts",
      "packages/runtime/src/review/review.ts",
      "packages/runtime/src/pi/runner.ts",
      "packages/sdk/src/builder.ts",
      "packages/sdk/src/prompt-json.ts",
      "packages/sdk/src/prompt-render.ts",
      "packages/sdk/src/prompt.ts",
      "packages/sdk/src/review-contract.ts",
    ],
    prefixes: [
      "packages/evals/",
      "packages/runtime/src/config/recipes/",
      "packages/runtime/src/review/agent/",
    ],
    patterns: [/^(packages\/(evals|runtime|sdk))\/package\.json$/],
  },
};

const eventName = env("EVENT_NAME");
let changed = true;
if (eventName !== "push") {
  const changeRange = getChangeRange(eventName);
  if (changeRange && !/^0+$/.test(changeRange.base)) {
    const changedFiles = gitChangedFiles(changeRange.base, changeRange.head);
    changed = changedFiles === undefined || changedFiles.some((file) => matchesScope(scope, file));
  }
}

await writeOutput("changed", String(changed));

function getChangeRange(eventName: string): { base: string; head: string } | undefined {
  if (eventName !== "pull_request") {
    return undefined;
  }
  const base = env("PR_BASE_SHA");
  const head = env("PR_HEAD_SHA");
  return base && head ? { base, head } : undefined;
}

function gitChangedFiles(base: string, head: string): string[] | undefined {
  if (!gitCommitExists(base) || !gitCommitExists(head)) {
    return undefined;
  }
  const result = Bun.spawnSync(["git", "diff", "--no-renames", "--name-only", base, head], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    return undefined;
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
  const selectedRules = rules[selectedScope];
  return (
    selectedRules.exact?.includes(file) === true ||
    selectedRules.prefixes?.some((prefix) => file.startsWith(prefix)) === true ||
    selectedRules.patterns?.some((pattern) => pattern.test(file)) === true
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
