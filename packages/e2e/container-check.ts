#!/usr/bin/env bun
import { join } from "node:path";
import { checkPiContract } from "./pi-contract.ts";
import {
  actionFixtureScript,
  envValue,
  fakePiScript,
  fixtureRootPath,
  type PreparedScenario,
  prepareScenarioWorktree,
  run,
  runOutput,
  type Scenario,
  type ScenarioAssertion,
  scenarioFromName,
  scenarioNames,
  scenarios,
  sourceRoot,
  writeWorktreeFile,
} from "./scenarios.ts";

type PublicationScenario = Scenario & {
  assertion: ScenarioAssertion;
  publicationFixture: string;
};

const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:e2e";
const scenarioArg = process.argv[2];
const selectedScenarios = scenarioArg
  ? [scenarioFromName(scenarioArg)].filter((item): item is Scenario => item !== undefined)
  : scenarioNames.map((name) => scenarios[name]);

if (scenarioArg && selectedScenarios.length === 0) {
  throw new Error(`usage: bun packages/e2e/container-check.ts [${scenarioNames.join("|")}]`);
}

assertDockerImageExists(actionImage);
await checkPiContract({ cwd: sourceRoot, image: actionImage });

for (const scenario of selectedScenarios) {
  await runContainerScenario(scenario);
}

async function runContainerScenario(scenario: Scenario): Promise<void> {
  const prepared = await prepareScenarioWorktree(scenario);
  try {
    run("chmod", ["-R", "a+rwX", prepared.worktree], sourceRoot);
    if (scenario.name === "dry-run") {
      runDryRunContainer(prepared);
      return;
    }
    await runFixtureContainer(prepared);
  } finally {
    prepared.cleanup();
  }
}

function runDryRunContainer(prepared: PreparedScenario): void {
  const env = {
    DEEPSEEK_API_KEY: "local-fixture-key",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: `/workspace/${prepared.scenario.eventFile}`,
    GITHUB_REPOSITORY: "local/pipr",
    GITHUB_TOKEN: "local-fixture-token",
    GITHUB_WORKSPACE: "/workspace",
    PIPR_DRY_RUN: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/workspace",
  };
  const output = runOutput(
    "docker",
    [
      "run",
      "--rm",
      "--mount",
      `type=bind,source=${prepared.worktree},target=/workspace`,
      "--workdir",
      "/workspace",
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      actionImage,
      "action",
      "--config-dir",
      ".pipr",
    ],
    sourceRoot,
  );
  const combined = `${output.stdout}\n${output.stderr}`;
  assertContains(combined, "pipr loaded change #1 for local/pipr");
  assertContains(combined, "pipr config source:");
  assertContains(
    combined,
    "PIPR_DRY_RUN=1; stopping before review runtime, model, or GitHub publishing calls",
  );
  console.log(`container ${prepared.scenario.name} ok`);
}

async function runFixtureContainer(prepared: PreparedScenario): Promise<void> {
  const scenario = publicationScenario(prepared.scenario);
  await prepareFixtureFiles(prepared, scenario);
  const env = fixtureEnv(scenario);
  run(
    "docker",
    [
      "run",
      "--rm",
      "--entrypoint",
      "/usr/local/bin/bun",
      "--mount",
      `type=bind,source=${prepared.worktree},target=/workspace`,
      "--workdir",
      "/workspace",
      ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      actionImage,
      `/opt/pipr/${actionFixtureScript}`,
      "action",
    ],
    sourceRoot,
  );
  console.log(`container ${scenario.name} ok`);
}

async function prepareFixtureFiles(
  prepared: PreparedScenario,
  scenario: PublicationScenario,
): Promise<void> {
  await writeWorktreeFile(
    prepared.worktree,
    `${fixtureRootPath}/${scenario.publicationFixture}`,
    `${JSON.stringify(
      {
        ownerLogin: "github-actions[bot]",
        headSha: prepared.headSha,
        issueComments: [],
        reviewComments: [],
        reviewThreads: [],
        reviewCommentPayloads: [],
      },
      null,
      2,
    )}\n`,
  );
  if (scenario.telemetryDir) {
    run(
      "mkdir",
      ["-p", join(prepared.worktree, fixtureRootPath, scenario.telemetryDir)],
      sourceRoot,
    );
  }
  run("chmod", ["-R", "a+rwX", join(prepared.worktree, fixtureRootPath)], sourceRoot);
}

function publicationScenario(scenario: Scenario): PublicationScenario {
  if (!scenario.publicationFixture || !scenario.assertion) {
    throw new Error(`scenario '${scenario.name}' is missing publication assertion metadata`);
  }
  return scenario as PublicationScenario;
}

function fixtureEnv(scenario: PublicationScenario): Record<string, string> {
  const telemetryPath = scenario.telemetryDir
    ? `/workspace/${fixtureRootPath}/${scenario.telemetryDir}`
    : undefined;
  return {
    DEEPSEEK_API_KEY: telemetryPath ?? "local-fixture-key",
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: `/workspace/${scenario.eventFile}`,
    GITHUB_OUTPUT: `/workspace/${fixtureRootPath}/github-output-${scenario.name}.txt`,
    GITHUB_REPOSITORY: "local/pipr",
    GITHUB_TOKEN: "local-fixture-token",
    GITHUB_WORKSPACE: "/workspace",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "/workspace",
    PIPR_ACT_ASSERTION: scenario.assertion,
    PIPR_ACT_GITHUB_FIXTURE_PATH: `/workspace/${fixtureRootPath}/${scenario.publicationFixture}`,
    PIPR_ACT_PI_EXECUTABLE: `/workspace/${fakePiScript}`,
    ...(telemetryPath ? { PIPR_ACT_TELEMETRY_PATH: telemetryPath } : {}),
  };
}

function assertDockerImageExists(image: string): void {
  const result = Bun.spawnSync(["docker", "image", "inspect", image], {
    stderr: "pipe",
    stdout: "ignore",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Docker image '${image}' not found; build it before check:container`);
  }
}

function assertContains(output: string, expected: string): void {
  if (!output.includes(expected)) {
    throw new Error(`container dry-run output missing '${expected}'`);
  }
}
