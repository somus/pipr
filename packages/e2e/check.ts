#!/usr/bin/env bun
import { checkPiContract } from "./pi-contract.ts";
import { envValue, run, scenarioNames, sourceRoot } from "./scenarios.ts";

const actionImage = envValue("PIPR_ACTION_IMAGE") ?? "pipr-action:act";

if (envValue("PIPR_SKIP_ACTION_IMAGE_BUILD") !== "1") {
  run("docker", ["build", "-t", actionImage, "."], sourceRoot);
}

run("bun", ["run", "--cwd", "packages/runtime", "build"], sourceRoot);
await checkPiContract({ cwd: sourceRoot, image: actionImage });
run("bun", ["packages/e2e/assertions.test.ts"], sourceRoot);
try {
  for (const scenario of scenarioNames) {
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
