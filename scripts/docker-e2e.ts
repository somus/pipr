#!/usr/bin/env bun
import { createDockerE2EPlan } from "../packages/e2e/docker-e2e-plan.ts";

const image =
  process.env.PIPR_TEST_ACTION_IMAGE ?? process.env.PIPR_ACTION_IMAGE ?? "pipr-action:e2e";

for (const step of createDockerE2EPlan(image)) {
  console.log(step.label);
  run(step.command, { ...process.env, ...step.env });
}

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
