#!/usr/bin/env bun
import { join } from "node:path";
import { renderActActionMetadata } from "./action-metadata.ts";
import {
  actionFixtureScript,
  envValue,
  fakePiScript,
  fixtureRootPath,
  prepareScenarioWorktree,
  run,
  type Scenario,
  scenarioFromName,
  scenarioNames,
  sourceRoot,
  writeWorktreeFile,
} from "./scenarios.ts";

const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:act";
const runnerImage = envValue("PIPR_ACT_RUNNER_IMAGE") ?? "catthehacker/ubuntu:act-latest";
const containerArchitecture = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
const githubToken = githubExpression("github.token");
const githubWorkspace = githubExpression("github.workspace");
const githubHeadSha = githubExpression("github.event.pull_request.head.sha");

const scenario = scenarioFromName(process.argv[2]);
if (!scenario) {
  throw new Error(`usage: bun packages/e2e/run.ts <${scenarioNames.join("|")}>`);
}

const prepared = await prepareScenarioWorktree(scenario, {
  beforeBaseCommit: async ({ scenario, worktree }) => {
    await writeActionMetadata(worktree, scenario);
    await writeWorkflow(worktree, scenario);
  },
  forceAddBasePaths: [".github/act/action.yml"],
});

try {
  ensureActRunnerImage();
  run(
    "act",
    [
      "pull_request",
      "-W",
      `.github/workflows/${scenario.workflowFile}`,
      "-e",
      scenario.eventFile,
      "-P",
      `ubuntu-latest=${runnerImage}`,
      "--container-architecture",
      containerArchitecture,
      "--pull=false",
      "--rm",
    ],
    prepared.worktree,
  );
} finally {
  prepared.cleanup();
}

async function writeActionMetadata(worktree: string, item: Scenario): Promise<void> {
  const source = await Bun.file(join(worktree, "action.yml")).text();
  const entrypointScript = item.assertion ? `/opt/pipr/${actionFixtureScript}` : undefined;
  await writeWorktreeFile(
    worktree,
    ".github/act/action.yml",
    renderActActionMetadata(source, actionImage, { entrypointScript }),
  );
}

async function writeWorkflow(worktree: string, item: Scenario): Promise<void> {
  await writeWorktreeFile(worktree, `.github/workflows/${item.workflowFile}`, workflowFor(item));
}

function workflowFor(item: Scenario): string {
  if (!item.publicationFixture || !item.assertion) {
    return dryRunWorkflow(item);
  }
  return fixtureWorkflow(item);
}

function dryRunWorkflow(item: Scenario): string {
  return [
    `name: ${item.title}`,
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "",
    "jobs:",
    "  pipr:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    "      - name: Prepare act workspace permissions",
    "        shell: bash",
    '        run: chmod -R a+rX "$GITHUB_WORKSPACE"',
    "      - uses: ./.github/act",
    "        env:",
    "          DEEPSEEK_API_KEY: local-fixture-key",
    `          GITHUB_TOKEN: ${githubToken}`,
    '          PIPR_DRY_RUN: "1"',
    "        with:",
    "          config-dir: .pipr",
    "",
  ].join("\n");
}

function fixtureWorkflow(item: Scenario): string {
  return [
    `name: ${item.title}`,
    "",
    "on:",
    "  pull_request:",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "",
    "jobs:",
    "  pipr:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    "      - name: Prepare act workspace permissions",
    "        shell: bash",
    '        run: chmod -R a+rX "$GITHUB_WORKSPACE"',
    "      - name: Prepare fake GitHub fixture",
    "        shell: bash",
    "        run: |",
    `          mkdir -p ${fixtureRootPath}`,
    `          cat > ${fixtureRootPath}/${item.publicationFixture} <<JSON`,
    "          {",
    '            "ownerLogin": "github-actions[bot]",',
    `            "headSha": "${githubHeadSha}",`,
    '            "issueComments": [],',
    '            "reviewComments": [],',
    '            "reviewThreads": [],',
    '            "reviewCommentPayloads": []',
    "          }",
    "          JSON",
    `          chmod 666 ${fixtureRootPath}/${item.publicationFixture}`,
    ...(item.telemetryDir
      ? [
          `          mkdir -p ${fixtureRootPath}/${item.telemetryDir}`,
          `          chmod 777 ${fixtureRootPath}/${item.telemetryDir}`,
        ]
      : []),
    "      - uses: ./.github/act",
    "        env:",
    `          DEEPSEEK_API_KEY: ${
      item.telemetryDir
        ? `${githubWorkspace}/${fixtureRootPath}/${item.telemetryDir}`
        : "local-fixture-key"
    }`,
    "          GITHUB_TOKEN: local-fixture-token",
    '          GIT_CONFIG_COUNT: "1"',
    "          GIT_CONFIG_KEY_0: safe.directory",
    `          GIT_CONFIG_VALUE_0: ${githubWorkspace}`,
    `          PIPR_ACT_GITHUB_FIXTURE_PATH: ${githubWorkspace}/${fixtureRootPath}/${item.publicationFixture}`,
    `          PIPR_ACT_PI_EXECUTABLE: ${githubWorkspace}/${fakePiScript}`,
    `          PIPR_ACT_ASSERTION: ${item.assertion}`,
    ...(item.telemetryDir
      ? [
          `          PIPR_ACT_TELEMETRY_PATH: ${githubWorkspace}/${fixtureRootPath}/${item.telemetryDir}`,
        ]
      : []),
    "        with:",
    "          config-dir: .pipr",
    "",
  ].join("\n");
}

function ensureActRunnerImage(): void {
  const inspected = Bun.spawnSync(["docker", "image", "inspect", runnerImage], {
    stderr: "ignore",
    stdout: "ignore",
  });
  if (inspected.exitCode !== 0) {
    run("docker", ["pull", "--platform", containerArchitecture, runnerImage], sourceRoot);
  }
}

function githubExpression(value: string): string {
  return "$".concat(`{{ ${value} }}`);
}
