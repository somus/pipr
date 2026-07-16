import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDockerfilePiVersion } from "./pi-contract.ts";

describe("Pi Dockerfile contract", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-contract-"));
  });

  afterEach(async () => {
    await rm(cwd, { force: true, recursive: true });
  });

  it("returns the shared pinned Pi package version", async () => {
    await writeDockerfile(cwd, [
      "@earendil-works/pi-coding-agent@0.80.3",
      "@earendil-works/pi-ai@0.80.3",
      "@earendil-works/pi-tui@0.80.3",
      "@earendil-works/pi-agent-core@0.80.3",
    ]);

    await expect(readDockerfilePiVersion(cwd)).resolves.toBe("0.80.3");
  });

  it("rejects a missing Pi package pin", async () => {
    await writeDockerfile(cwd, [
      "@earendil-works/pi-coding-agent@0.80.3",
      "@earendil-works/pi-ai@0.80.3",
      "@earendil-works/pi-agent-core@0.80.3",
    ]);

    await expect(readDockerfilePiVersion(cwd)).rejects.toThrow(
      "Dockerfile does not pin @earendil-works/pi-tui",
    );
  });

  it("requires every Pi package to use the coding-agent version", async () => {
    await writeDockerfile(cwd, [
      "@earendil-works/pi-coding-agent@0.80.3",
      "@earendil-works/pi-ai@0.80.8",
      "@earendil-works/pi-tui@0.80.3",
      "@earendil-works/pi-agent-core@0.80.3",
    ]);

    await expect(readDockerfilePiVersion(cwd)).rejects.toThrow(
      "Dockerfile Pi package versions must match",
    );
  });
});

async function writeDockerfile(cwd: string, packages: string[]): Promise<void> {
  await Bun.write(path.join(cwd, "Dockerfile"), `RUN bun add -g ${packages.join(" ")}\n`);
}
