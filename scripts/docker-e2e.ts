#!/usr/bin/env bun
const image =
  process.env.PIPR_TEST_ACTION_IMAGE ?? process.env.PIPR_ACTION_IMAGE ?? "pipr-action:e2e";

run(["docker", "build", "--target", "e2e", "--tag", image, "."]);
run(["bun", "run", "--cwd", "packages/e2e", "check:container"], {
  ...process.env,
  PIPR_ACTION_IMAGE: image,
});

function run(command: string[], env = process.env): void {
  const result = Bun.spawnSync(command, {
    env,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed with exit ${result.exitCode}`);
  }
}
