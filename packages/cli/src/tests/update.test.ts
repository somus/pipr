import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseAssetForPlatform, runPiprUpdate } from "../update.js";

describe("pipr update", () => {
  it("resolves release assets for supported platforms", () => {
    expect(releaseAssetForPlatform({ platform: "linux", arch: "x64" })).toBe("pipr-linux-x64");
    expect(releaseAssetForPlatform({ platform: "linux", arch: "arm64" })).toBe("pipr-linux-arm64");
    expect(releaseAssetForPlatform({ platform: "darwin", arch: "x64" })).toBe("pipr-darwin-x64");
    expect(releaseAssetForPlatform({ platform: "darwin", arch: "arm64" })).toBe(
      "pipr-darwin-arm64",
    );
  });

  it("rejects unsupported platforms", () => {
    expect(() => releaseAssetForPlatform({ platform: "win32", arch: "x64" })).toThrow(
      "unsupported OS",
    );
    expect(() => releaseAssetForPlatform({ platform: "linux", arch: "ia32" })).toThrow(
      "unsupported architecture",
    );
  });

  it("rejects checksum mismatches before replacing the executable", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.2.0");

      await expect(
        runPiprUpdate({
          currentVersion: "0.1.0",
          executablePath,
          fetch: fakeReleaseFetch({
            asset: "pipr-linux-x64",
            binary,
            checksum: "0".repeat(64),
          }),
          platform: { platform: "linux", arch: "x64" },
        }),
      ).rejects.toThrow("checksum mismatch");

      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });

  it("rejects missing checksum entries before replacing the executable", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.2.0");

      await expect(
        runPiprUpdate({
          currentVersion: "0.1.0",
          executablePath,
          fetch: fakeReleaseFetch({
            asset: "pipr-linux-x64",
            binary,
            checksum: sha256(binary),
            checksumAsset: "pipr-darwin-arm64",
          }),
          platform: { platform: "linux", arch: "x64" },
        }),
      ).rejects.toThrow("checksum for pipr-linux-x64 not found");

      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });

  it("rejects invalid downloaded binary versions before replacing the executable", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("not-a-version");

      await expect(
        runPiprUpdate({
          currentVersion: "0.1.0",
          executablePath,
          fetch: fakeReleaseFetch({
            asset: "pipr-linux-x64",
            binary,
            checksum: sha256(binary),
          }),
          platform: { platform: "linux", arch: "x64" },
        }),
      ).rejects.toThrow("invalid version");

      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });

  it("replaces the executable after checksum and version validation", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.2.0");

      const result = await runPiprUpdate({
        currentVersion: "0.1.0",
        executablePath,
        fetch: fakeReleaseFetch({
          asset: "pipr-linux-x64",
          binary,
          checksum: sha256(binary),
        }),
        platform: { platform: "linux", arch: "x64" },
      });

      expect(result).toEqual({ kind: "updated", version: "0.2.0", previousVersion: "0.1.0" });
      expect(await Bun.file(executablePath).text()).toBe(binary);
    });
  });

  it("does not replace the executable when it is already current", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.1.0");

      const result = await runPiprUpdate({
        currentVersion: "0.1.0",
        executablePath,
        fetch: fakeReleaseFetch({
          asset: "pipr-linux-x64",
          binary,
          checksum: sha256(binary),
        }),
        platform: { platform: "linux", arch: "x64" },
      });

      expect(result).toEqual({ kind: "up-to-date", version: "0.1.0" });
      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });

  it("does not replace the executable when the local version is newer than latest", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.1.0");

      const result = await runPiprUpdate({
        currentVersion: "0.2.0",
        executablePath,
        fetch: fakeReleaseFetch({
          asset: "pipr-linux-x64",
          binary,
          checksum: sha256(binary),
        }),
        platform: { platform: "linux", arch: "x64" },
      });

      expect(result).toEqual({ kind: "up-to-date", version: "0.2.0" });
      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });
});

async function withUpdateWorkspace(
  run: (workspace: { executablePath: string }) => Promise<void>,
): Promise<void> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-update-"));
  try {
    const executablePath = path.join(workspace, "pipr");
    await Bun.write(executablePath, "old pipr\n");
    await chmod(executablePath, 0o755);
    await run({ executablePath });
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

function fakeReleaseFetch(options: {
  asset: string;
  binary: string;
  checksum: string;
  checksumAsset?: string;
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url.endsWith(`/download/${options.asset}`)) {
      return new Response(options.binary);
    }
    if (url.endsWith("/download/SHA256SUMS")) {
      return new Response(`${options.checksum}  ${options.checksumAsset ?? options.asset}\n`);
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function versionBinary(version: string): string {
  return ["#!/bin/sh", `echo ${JSON.stringify(version)}`, ""].join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
