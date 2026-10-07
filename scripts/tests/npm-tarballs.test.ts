import { describe, expect, it } from "bun:test";
import { verifyPackedPackage } from "../verify-npm-tarballs.js";

const rootLicense = "MIT license fixture\n";
const cliManifest = {
  name: "@usepipr/cli",
  version: "1.2.3",
  files: ["dist", "LICENSE"],
  bin: { pipr: "./dist/main.mjs" },
};
const sdkManifest = {
  name: "@usepipr/sdk",
  version: "1.2.3",
  files: ["dist", "LICENSE"],
  main: "./dist/index.mjs",
  types: "./dist/index.d.mts",
  exports: {
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./config": { import: "./dist/config.mjs" },
  },
};
const validSdkFiles = [
  { path: "LICENSE" },
  { path: "README.md" },
  { path: "package.json" },
  { path: "dist/index.mjs" },
  { path: "dist/index.d.mts" },
  { path: "dist/config.mjs" },
];
const validCliFiles = [
  { path: "LICENSE", mode: 0o644 },
  { path: "README.md", mode: 0o644 },
  { path: "package.json", mode: 0o644 },
  { path: "dist/main.mjs", mode: 0o755 },
  { path: "dist/main.d.mts", mode: 0o644 },
  { path: "dist/skills/pipr-setup/SKILL.md", mode: 0o644 },
  { path: "dist/skills/pipr-setup/references/config-patterns.md", mode: 0o644 },
  { path: "dist/skills/pipr-setup/references/recipes.md", mode: 0o644 },
];

describe("verifyPackedPackage", () => {
  it("accepts the deliberate CLI package surface", () => {
    expect(() =>
      verifyPackedPackage({
        manifest: cliManifest,
        files: validCliFiles,
        rootLicense,
        packedLicense: rootLicense,
      }),
    ).not.toThrow();
  });

  it.each([
    [
      "missing LICENSE",
      validCliFiles.filter((file) => file.path !== "LICENSE"),
      rootLicense,
      "tarball is missing LICENSE",
    ],
    ["mismatched LICENSE", validCliFiles, "different license\n", "differs from the root license"],
    [
      "missing README",
      validCliFiles.filter((file) => file.path !== "README.md"),
      rootLicense,
      "tarball is missing README.md",
    ],
    [
      "missing bin",
      validCliFiles.filter((file) => file.path !== "dist/main.mjs"),
      rootLicense,
      "tarball is missing entrypoint dist/main.mjs",
    ],
    [
      "non-executable bin",
      validCliFiles.map((file) =>
        file.path === "dist/main.mjs" ? { ...file, mode: 0o644 } : file,
      ),
      rootLicense,
      "pipr executable must use mode 0755",
    ],
    [
      "missing bundled skill",
      validCliFiles.filter((file) => file.path !== "dist/skills/pipr-setup/references/recipes.md"),
      rootLicense,
      "tarball is missing dist/skills/pipr-setup/references/recipes.md",
    ],
    [
      "source file",
      [...validCliFiles, { path: "src/main.ts", mode: 0o644 }],
      rootLicense,
      "unexpected path src/main.ts",
    ],
    [
      "unexpected root file",
      [...validCliFiles, { path: "CHANGELOG.md" }],
      rootLicense,
      "unexpected path CHANGELOG.md",
    ],
    [
      "dotfile under dist",
      [...validCliFiles, { path: "dist/.env" }],
      rootLicense,
      "tarball exposes dist/.env",
    ],
    [
      "fixtures under dist",
      [...validCliFiles, { path: "dist/fixtures/event.json" }],
      rootLicense,
      "tarball exposes dist/fixtures/event.json",
    ],
    [
      "compiled test",
      [...validCliFiles, { path: "dist/tests/main.test.mjs", mode: 0o644 }],
      rootLicense,
      "tarball exposes dist/tests/main.test.mjs",
    ],
  ])("rejects %s", (_name, files, packedLicense, message) => {
    expect(() =>
      verifyPackedPackage({
        manifest: cliManifest,
        files,
        rootLicense,
        packedLicense,
      }),
    ).toThrow(message);
  });

  it("accepts a library package whose nested exports all exist", () => {
    expect(() =>
      verifyPackedPackage({
        manifest: sdkManifest,
        files: validSdkFiles,
        rootLicense,
        packedLicense: rootLicense,
      }),
    ).not.toThrow();
  });

  it("rejects a library package missing a nested conditional export", () => {
    expect(() =>
      verifyPackedPackage({
        manifest: sdkManifest,
        files: validSdkFiles.filter((file) => file.path !== "dist/config.mjs"),
        rootLicense,
        packedLicense: rootLicense,
      }),
    ).toThrow("@usepipr/sdk tarball is missing entrypoint dist/config.mjs");
  });

  it("rejects a files allowlist that drifts from dist and LICENSE", () => {
    expect(() =>
      verifyPackedPackage({
        manifest: { ...sdkManifest, files: ["dist", "LICENSE", "src"] },
        files: validSdkFiles,
        rootLicense,
        packedLicense: rootLicense,
      }),
    ).toThrow("@usepipr/sdk files allowlist drifted");
  });
});
