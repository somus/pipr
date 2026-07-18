import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepareScenarioWorktree, scenarios } from "./scenarios.ts";

test("cleans scenario worktrees with restrictive permissions", async () => {
  await assertScenarioCleanupHandlesRestrictivePermissions();
});

async function assertScenarioCleanupHandlesRestrictivePermissions(): Promise<void> {
  const prepared = await prepareScenarioWorktree(scenarios.full);
  const restrictedDir = join(prepared.worktree, ".pipr/.act/restricted");
  mkdirSync(restrictedDir, { recursive: true });
  writeFileSync(join(restrictedDir, "fake-pi-wrapper"), "#!/bin/sh\n");
  chmodSync(restrictedDir, 0o500);

  try {
    prepared.cleanup();
    expect(existsSync(prepared.tmpRoot)).toBe(false);
  } finally {
    if (existsSync(restrictedDir)) {
      chmodSync(restrictedDir, 0o700);
    }
    if (existsSync(prepared.tmpRoot)) {
      prepared.cleanup();
    }
  }
}
