import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { availablePiprUpdateNotice, releaseAssetForPlatform, runPiprUpdate } from "../update.js";

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

  it("returns an update notice when the latest release is newer", async () => {
    const requests: string[] = [];

    const notice = await availablePiprUpdateNotice({
      currentVersion: "0.1.0",
      fetch: fakeReleaseFetch({
        asset: "pipr-linux-x64",
        binary: "unused",
        checksum: "unused",
        releaseVersion: "0.2.0",
        requests,
      }),
    });

    expect(notice).toEqual({ currentVersion: "0.1.0", latestVersion: "0.2.0" });
    expect(requests).toEqual(["https://api.github.com/repos/somus/pipr/releases/latest"]);
  });

  it("does not return an update notice when the current version is already latest", async () => {
    const requests: string[] = [];

    const notice = await availablePiprUpdateNotice({
      currentVersion: "0.2.0",
      fetch: fakeReleaseFetch({
        asset: "pipr-linux-x64",
        binary: "unused",
        checksum: "unused",
        releaseVersion: "0.2.0",
        requests,
      }),
    });

    expect(notice).toBeUndefined();
    expect(requests).toEqual(["https://api.github.com/repos/somus/pipr/releases/latest"]);
  });

  it("does not fetch an update notice for non-stable current versions", async () => {
    const requests: string[] = [];

    const notice = await availablePiprUpdateNotice({
      currentVersion: "0.2.0-beta.1",
      fetch: fakeReleaseFetch({
        asset: "pipr-linux-x64",
        binary: "unused",
        checksum: "unused",
        releaseVersion: "0.2.0",
        requests,
      }),
    });

    expect(notice).toBeUndefined();
    expect(requests).toEqual([]);
  });

  it("rejects non-stable current versions before fetching release metadata", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const requests: string[] = [];

      await expect(
        runPiprUpdate({
          currentVersion: "0.1.0-beta.1",
          executablePath,
          fetch: fakeReleaseFetch({
            asset: "pipr-linux-x64",
            binary: versionBinary("0.2.0"),
            checksum: "unused",
            requests,
          }),
          platform: { platform: "linux", arch: "x64" },
        }),
      ).rejects.toThrow("current pipr version is not a stable semver version");

      expect(requests).toEqual([]);
      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
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

  it("rejects non-stable latest release versions before downloading assets", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.2.0-beta.1");
      const requests: string[] = [];

      await expect(
        runPiprUpdate({
          currentVersion: "0.1.0",
          executablePath,
          fetch: fakeReleaseFetch({
            asset: "pipr-linux-x64",
            binary,
            checksum: sha256(binary),
            releaseVersion: "0.2.0-beta.1",
            requests,
          }),
          platform: { platform: "linux", arch: "x64" },
        }),
      ).rejects.toThrow("latest release tag is not a stable semver version");

      expect(requests).toEqual(["https://api.github.com/repos/somus/pipr/releases/latest"]);
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

  it("rejects mismatched downloaded binary versions before replacing the executable", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.3.0");

      await expect(
        runPiprUpdate({
          currentVersion: "0.1.0",
          executablePath,
          fetch: fakeReleaseFetch({
            asset: "pipr-linux-x64",
            binary,
            checksum: sha256(binary),
            releaseVersion: "0.2.0",
          }),
          platform: { platform: "linux", arch: "x64" },
        }),
      ).rejects.toThrow("downloaded pipr binary reported 0.3.0, expected latest 0.2.0");

      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });

  it("validates downloaded binary versions without caller env or cwd", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const originalSecret = Bun.env.PIPR_UPDATE_TEST_SECRET;
      const binary = [
        "#!/bin/sh",
        'if [ "$PIPR_UPDATE_TEST_SECRET" = "secret" ]; then echo leaked secret >&2; exit 2; fi',
        `if [ "$(pwd)" = ${shellQuote(process.cwd())} ]; then echo inherited cwd >&2; exit 3; fi`,
        "echo 0.2.0",
        "",
      ].join("\n");

      Bun.env.PIPR_UPDATE_TEST_SECRET = "secret";
      try {
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
      } finally {
        if (originalSecret === undefined) {
          delete Bun.env.PIPR_UPDATE_TEST_SECRET;
        } else {
          Bun.env.PIPR_UPDATE_TEST_SECRET = originalSecret;
        }
      }
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

  it("refuses to follow an existing temp path before replacing the executable", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.2.0");
      const tempPath = path.join(path.dirname(executablePath), `.pipr-update-${process.pid}-12345`);
      const symlinkTarget = path.join(path.dirname(executablePath), "target");
      const originalNow = Date.now;

      await Bun.write(symlinkTarget, "target\n");
      await symlink(symlinkTarget, tempPath);
      Date.now = () => 12345;
      try {
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
        ).rejects.toThrow();
      } finally {
        Date.now = originalNow;
      }

      expect(await Bun.file(symlinkTarget).text()).toBe("target\n");
      expect(await Bun.file(tempPath).text()).toBe("target\n");
      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
    });
  });

  it("does not replace the executable when it is already current", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.1.0");
      const requests: string[] = [];

      const result = await runPiprUpdate({
        currentVersion: "0.1.0",
        executablePath,
        fetch: fakeReleaseFetch({
          asset: "pipr-linux-x64",
          binary,
          checksum: sha256(binary),
          releaseVersion: "0.1.0",
          requests,
        }),
        platform: { platform: "linux", arch: "x64" },
      });

      expect(result).toEqual({ kind: "up-to-date", version: "0.1.0" });
      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
      expect(requests).not.toContain(
        "https://github.com/somus/pipr/releases/download/v0.1.0/pipr-linux-x64",
      );
    });
  });

  it("does not replace the executable when the local version is newer than latest", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const binary = versionBinary("0.1.0");
      const requests: string[] = [];

      const result = await runPiprUpdate({
        currentVersion: "0.2.0",
        executablePath,
        fetch: fakeReleaseFetch({
          asset: "pipr-linux-x64",
          binary,
          checksum: sha256(binary),
          releaseVersion: "0.1.0",
          requests,
        }),
        platform: { platform: "linux", arch: "x64" },
      });

      expect(result).toEqual({ kind: "up-to-date", version: "0.2.0" });
      expect(await Bun.file(executablePath).text()).toBe("old pipr\n");
      expect(requests).not.toContain(
        "https://github.com/somus/pipr/releases/download/v0.1.0/pipr-linux-x64",
      );
    });
  });

  it("uses the official release source and pins downloads to the resolved tag", async () => {
    await withUpdateWorkspace(async ({ executablePath }) => {
      const requests: string[] = [];
      const binary = versionBinary("0.2.0");

      await runPiprUpdate({
        currentVersion: "0.1.0",
        executablePath,
        fetch: fakeReleaseFetch({
          asset: "pipr-linux-x64",
          binary,
          checksum: sha256(binary),
          requests,
        }),
        platform: { platform: "linux", arch: "x64" },
      });

      expect(requests[0]).toBe("https://api.github.com/repos/somus/pipr/releases/latest");
      expect(requests).toContain(
        "https://github.com/somus/pipr/releases/download/v0.2.0/pipr-linux-x64",
      );
      expect(requests).toContain(
        "https://github.com/somus/pipr/releases/download/v0.2.0/SHA256SUMS",
      );
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
  releaseVersion?: string;
  requests?: string[];
}): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    options.requests?.push(url);
    if (url.endsWith("/releases/latest") && url.startsWith("https://api.github.com/repos/")) {
      return Response.json({ tag_name: `v${options.releaseVersion ?? "0.2.0"}` });
    }
    if (url.endsWith(`/${options.asset}`)) {
      return new Response(options.binary);
    }
    if (url.endsWith("/SHA256SUMS")) {
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
