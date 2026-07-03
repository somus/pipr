#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

const image =
  process.env.PIPR_TEST_ACTION_IMAGE ?? process.env.PIPR_ACTION_IMAGE ?? "pipr-action:e2e";

run(["docker", "build", "--target", "e2e", "--tag", image, "."]);
run(["bun", "run", "--cwd", "packages/e2e", "check:container"], {
  ...process.env,
  PIPR_ACTION_IMAGE: image,
});

function run(command: string[], env = process.env): void {
  const result = spawnSync(command[0] as string, command.slice(1), {
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${result.status}`);
  }
}
