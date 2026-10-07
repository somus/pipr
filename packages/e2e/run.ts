#!/usr/bin/env bun
import { join } from "node:path";
import { renderActActionMetadata } from "./action-metadata.ts";
import { actArguments, containerArchitecture } from "./action-run-plan.ts";
import {
  actionFixtureScript,
  envValue,
  isPublicationScenario,
  prepareScenarioWorktree,
  publicationFixtureEnv,
  run,
  type Scenario,
  scenarioFromName,
  scenarioNames,
  sourceRoot,
  writePublicationFixture,
  writeWorktreeFile,
} from "./scenarios.ts";

const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:act";
const runnerImage = envValue("PIPR_ACT_RUNNER_IMAGE") ?? "catthehacker/ubuntu:act-latest";
const githubToken = githubExpression("github.token");
const githubWorkspace = githubExpression("github.workspace");

const scenario = scenarioFromName(process.argv[2]);
if (!scenario) {
  throw new Error(`usage: bun packages/e2e/run.ts <${scenarioNames.join("|")}>`);
}

const prepared = await prepareScenarioWorktree(scenario, {
  beforeBaseCommit: async ({ scenario, worktree }) => {
    await writeActionMetadata(worktree, scenario);
    await writeWorkflow(worktree, scenario);
    run("git", ["add", "-f", ".github/act/action.yml"], worktree);
  },
});

try {
  if (isPublicationScenario(scenario)) {
    await writePublicationFixture(prepared, scenario);
  }
  ensureActRunnerImage();
  run(
    "act",
    actArguments({
      eventFile: scenario.eventFile,
      runnerImage,
      workflowFile: scenario.workflowFile,
    }),
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
  if (isPublicationScenario(item)) {
    return workflow(item, ["  pull_request:"], publicationFixtureEnv(item, githubWorkspace));
  }
  return workflow(
    item,
    [
      "  pull_request:",
      "  issue_comment:",
      "    types: [created]",
      "  pull_request_review_comment:",
      "    types: [created]",
    ],
    { DEEPSEEK_API_KEY: "local-fixture-key", GITHUB_TOKEN: githubToken, PIPR_DRY_RUN: "1" },
  );
}

function workflow(item: Scenario, triggers: string[], env: Record<string, string>): string {
  return [
    `name: ${item.title}`,
    "",
    "on:",
    ...triggers,
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
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-depth: 0",
    "      - name: Prepare act workspace permissions",
    "        shell: bash",
    '        run: chmod -R a+rX "$GITHUB_WORKSPACE"',
    "      - uses: ./.github/act",
    "        env:",
    ...Object.entries(env).map(([key, value]) => `          ${key}: ${JSON.stringify(value)}`),
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
