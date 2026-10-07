import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkHarnessContract, readHarnessVersion } from "./harness-contract.ts";
import { sourceRoot } from "./scenarios.ts";

const pinned = {
  "@earendil-works/pi-durable": "1.0.4",
  "@earendil-works/pi-ai": "1.0.4",
  "@earendil-works/chord": "1.0.4",
};

describe("durable harness contract", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "pipr-harness-contract-"));
  });

  afterEach(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it("returns the shared pinned harness version", async () => {
    await writeWorkspace(cwd, { runtime: pinned, e2e: { "@earendil-works/pi-ai": "1.0.4" } });

    await expect(readHarnessVersion(cwd)).resolves.toBe("1.0.4");
  });

  it("rejects a missing runtime harness dependency", async () => {
    const { "@earendil-works/chord": _chord, ...runtime } = pinned;
    await writeWorkspace(cwd, { runtime });

    await expect(readHarnessVersion(cwd)).rejects.toThrow(
      "packages/runtime/package.json does not depend on @earendil-works/chord",
    );
  });

  it("requires harness packages to share one exact version", async () => {
    await writeWorkspace(cwd, { runtime: { ...pinned, "@earendil-works/pi-ai": "^1.0.4" } });

    await expect(readHarnessVersion(cwd)).rejects.toThrow(
      "Harness packages must share one exact version",
    );
  });

  it("requires fixture providers to pin the runtime harness version", async () => {
    await writeWorkspace(cwd, { runtime: pinned, evals: { "@earendil-works/pi-ai": "1.0.3" } });

    await expect(readHarnessVersion(cwd)).rejects.toThrow(
      "packages/evals/package.json pins @earendil-works/pi-ai@1.0.3; expected 1.0.4",
    );
  });

  it("requires the lockfile to resolve the pinned version", async () => {
    await writeWorkspace(cwd, { runtime: pinned, lockedVersion: "1.0.3" });

    await expect(readHarnessVersion(cwd)).rejects.toThrow(
      "bun.lock does not resolve @earendil-works/pi-durable@1.0.4",
    );
  });

  it("accepts this repository's pins and agent worker entry", async () => {
    await expect(checkHarnessContract({ cwd: sourceRoot })).resolves.toBeUndefined();
  });
});

async function writeWorkspace(
  cwd: string,
  options: {
    runtime: Record<string, string>;
    e2e?: Record<string, string>;
    evals?: Record<string, string>;
    lockedVersion?: string;
  },
): Promise<void> {
  for (const [name, dependencies] of Object.entries({
    runtime: options.runtime,
    e2e: options.e2e ?? {},
    evals: options.evals ?? {},
  })) {
    await mkdir(path.join(cwd, "packages", name), { recursive: true });
    await Bun.write(
      path.join(cwd, "packages", name, "package.json"),
      JSON.stringify({ name, dependencies }),
    );
  }
  const locked = options.lockedVersion ?? "1.0.4";
  await Bun.write(
    path.join(cwd, "bun.lock"),
    Object.keys(pinned)
      .map((name) => `    "${name}": ["${name}@${locked}", "", {}, "sha512-fixture"],`)
      .join("\n"),
  );
}
