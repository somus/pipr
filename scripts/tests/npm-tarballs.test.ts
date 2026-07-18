import { describe, expect, it } from "bun:test";
import { verifyPackedPackage } from "../verify-npm-tarballs.js";

const rootLicense = "MIT license fixture\n";
const cliManifest = {
  name: "@usepipr/cli",
  version: "1.2.3",
  files: ["dist", "LICENSE"],
  bin: { pipr: "./dist/main.mjs" },
};
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
    ["missing LICENSE", validCliFiles.filter((file) => file.path !== "LICENSE"), rootLicense],
    ["mismatched LICENSE", validCliFiles, "different license\n"],
    ["missing bin", validCliFiles.filter((file) => file.path !== "dist/main.mjs"), rootLicense],
    [
      "non-executable bin",
      validCliFiles.map((file) =>
        file.path === "dist/main.mjs" ? { ...file, mode: 0o644 } : file,
      ),
      rootLicense,
    ],
    ["source file", [...validCliFiles, { path: "src/main.ts", mode: 0o644 }], rootLicense],
    [
      "compiled test",
      [...validCliFiles, { path: "dist/tests/main.test.mjs", mode: 0o644 }],
      rootLicense,
    ],
  ])("rejects %s", (_name, files, packedLicense) => {
    expect(() =>
      verifyPackedPackage({
        manifest: cliManifest,
        files,
        rootLicense,
        packedLicense,
      }),
    ).toThrow();
  });
});
