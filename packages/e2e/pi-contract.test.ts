import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readDockerfilePiVersion } from "./pi-contract.ts";

describe("Pi Dockerfile contract", () => {
  it("requires every Pi package to use the coding-agent version", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-contract-"));
    await Bun.write(
      path.join(cwd, "Dockerfile"),
      [
        "RUN bun add -g \\",
        "  @earendil-works/pi-coding-agent@0.80.3 \\",
        "  @earendil-works/pi-ai@0.80.8 \\",
        "  @earendil-works/pi-tui@0.80.3 \\",
        "  @earendil-works/pi-agent-core@0.80.3",
      ].join("\n"),
    );

    await expect(readDockerfilePiVersion(cwd)).rejects.toThrow(
      "Dockerfile Pi package versions must match",
    );
    await rm(cwd, { force: true, recursive: true });
  });
});
