#!/usr/bin/env bun
import { join } from "node:path";
import {
  actionFixtureScript,
  envValue,
  fixtureRootPath,
  isPublicationScenario,
  type PreparedScenario,
  prepareScenarioWorktree,
  publicationFixtureEnv,
  run,
  runOutput,
  type Scenario,
  scenarioFromName,
  scenarioNames,
  scenarios,
  sourceRoot,
  writePublicationFixture,
} from "./scenarios.ts";

const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:e2e";
const scenarioArg = process.argv[2];
const selectedScenarios = scenarioArg
  ? [scenarioFromName(scenarioArg)].filter((item): item is Scenario => item !== undefined)
  : scenarioNames.map((name) => scenarios[name]);

if (scenarioArg && selectedScenarios.length === 0) {
  throw new Error(`usage: bun packages/e2e/container-check.ts [${scenarioNames.join("|")}]`);
}

assertDockerImageExists(actionImage);
assertAstGrepContract(actionImage);
assertWebhookEntrypoint(actionImage);
assertRunStoreWritable(actionImage);
await assertWebhookHealth(actionImage);

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
    ...containerGitHubEnv(prepared.scenario),
    DEEPSEEK_API_KEY: "local-fixture-key",
    GITHUB_ACTIONS: "true",
    GITHUB_TOKEN: "local-fixture-token",
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
      "host-run",
      "--host",
      "github",
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
  const scenario = prepared.scenario;
  if (!isPublicationScenario(scenario)) {
    throw new Error(`scenario '${scenario.name}' is missing publication assertion metadata`);
  }
  await writePublicationFixture(prepared, scenario);
  const env = {
    ...containerGitHubEnv(scenario),
    GITHUB_OUTPUT: `/workspace/${fixtureRootPath}/github-output-${scenario.name}.txt`,
    ...publicationFixtureEnv(scenario, "/workspace"),
  };
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
      "host-run",
      "--host",
      "github",
    ],
    sourceRoot,
  );
  console.log(`container ${scenario.name} ok`);
}

/** The GitHub Actions variables a pull request run sees, for a worktree mounted at `/workspace`. */
function containerGitHubEnv(scenario: Scenario): Record<string, string> {
  return {
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_EVENT_PATH: `/workspace/${scenario.eventFile}`,
    GITHUB_REPOSITORY: "local/pipr",
    GITHUB_WORKSPACE: "/workspace",
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

function assertAstGrepContract(image: string): void {
  const version = runOutput(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--entrypoint",
      "/usr/local/bin/ast-grep",
      image,
      "--version",
    ],
    sourceRoot,
  );
  if (version.stdout.trim() !== "ast-grep 0.45.0") {
    throw new Error(`container ast-grep version mismatch: '${version.stdout.trim()}'`);
  }
  runOutput(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--entrypoint",
      "/usr/local/bin/ast-grep",
      image,
      "outline",
      "--help",
    ],
    sourceRoot,
  );
  console.log("container ast-grep contract ok");
}

function assertWebhookEntrypoint(image: string): void {
  const output = runOutput(
    "docker",
    ["run", "--rm", "--user", "1000:1000", image, "webhook", "serve", "--help"],
    sourceRoot,
  );
  assertContains(output.stdout, "--repository <repository>");
  assertContains(output.stdout, "--database <path>");
  assertContains(output.stdout, "--hostname <hostname>");
  console.log("container webhook entrypoint ok");
}

function assertRunStoreWritable(image: string): void {
  run(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      "test -d /var/lib/pipr/runs && test -w /var/lib/pipr/runs",
    ],
    sourceRoot,
  );
  console.log("container run store writable ok");
}

async function assertWebhookHealth(image: string): Promise<void> {
  const healthcheckCommand = await webhookComposeHealthcheckCommand();
  const output = runOutput(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      "1000:1000",
      "--entrypoint",
      "/usr/local/bin/bun",
      image,
      "/opt/pipr/packages/e2e/webhook-health-fixture.ts",
      "--",
      ...healthcheckCommand,
    ],
    sourceRoot,
  );
  for (const host of ["gitlab", "azure-devops", "bitbucket"]) {
    assertContains(output.stdout, `container webhook ${host} Compose healthcheck ok`);
  }
}

async function webhookComposeHealthcheckCommand(): Promise<string[]> {
  const compose = Bun.YAML.parse(
    await Bun.file(join(sourceRoot, "deploy/webhook/compose.yml")).text(),
  ) as { services?: { webhook?: { healthcheck?: { test?: unknown } } } };
  const test = compose.services?.webhook?.healthcheck?.test;
  if (!isComposeHealthcheck(test)) {
    throw new Error("webhook Compose healthcheck must use a string CMD array");
  }
  return test.slice(1);
}

function isComposeHealthcheck(value: unknown): value is ["CMD", ...string[]] {
  return (
    Array.isArray(value) &&
    value.length > 1 &&
    value[0] === "CMD" &&
    value.slice(1).every((part) => typeof part === "string")
  );
}

function assertContains(output: string, expected: string): void {
  if (!output.includes(expected)) {
    throw new Error(`container dry-run output missing '${expected}'`);
  }
}
