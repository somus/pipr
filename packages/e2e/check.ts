#!/usr/bin/env bun
import { checkPiContract } from "./pi-contract.ts";
import { envValue, run, scenarioFromName, scenarioNames, sourceRoot } from "./scenarios.ts";

const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:act";
const scenarioArg = process.argv[2];
const selectedScenario = scenarioArg ? scenarioFromName(scenarioArg) : undefined;
if (scenarioArg && !selectedScenario) {
  throw new Error(`usage: bun packages/e2e/check.ts [${scenarioNames.join("|")}]`);
}
const selectedScenarioNames = selectedScenario ? [selectedScenario.name] : scenarioNames;

if (envValue("PIPR_SKIP_ACTION_IMAGE_BUILD") !== "1") {
  run("docker", ["build", "--target", "e2e", "-t", actionImage, "."], sourceRoot);
}

run("bun", ["run", "--cwd", "packages/runtime", "build"], sourceRoot);
await checkPiContract({ cwd: sourceRoot, image: actionImage });
run("bun", ["test", "packages/e2e/assertions.test.ts"], sourceRoot);
try {
  for (const scenario of selectedScenarioNames) {
    run("bun", ["packages/e2e/run.ts", scenario], sourceRoot);
  }
} finally {
  removeActToolcache();
}

function removeActToolcache(): void {
  Bun.spawnSync(["docker", "volume", "rm", "act-toolcache"], {
    cwd: sourceRoot,
    env: Bun.env,
    stderr: "ignore",
    stdout: "ignore",
  });
}
