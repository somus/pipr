import { describe, expect, it } from "bun:test";
import path from "node:path";
import { sdkModuleStubSource, sdkPackageRootFromResolvedModule } from "../sdk-module.js";

describe("SDK module resolution", () => {
  it("uses the embedded runtime SDK module when module resolution fails", () => {
    expect(sdkModuleStubSource(undefined, "export const embedded = true;\n")).toBe(
      "export const embedded = true;\n",
    );
  });

  it("fails when neither a resolved nor embedded runtime SDK module is available", () => {
    expect(() => sdkModuleStubSource(undefined, undefined)).toThrow(
      "Unable to locate @usepipr/sdk runtime module",
    );
  });

  it("derives the SDK package root from source, dist, and package-root module paths", () => {
    const packageRoot = path.join("/", "repo", "node_modules", "@usepipr", "sdk");

    expect(sdkPackageRootFromResolvedModule(path.join(packageRoot, "src", "index.ts"))).toBe(
      packageRoot,
    );
    expect(sdkPackageRootFromResolvedModule(path.join(packageRoot, "dist", "index.js"))).toBe(
      packageRoot,
    );
    expect(sdkPackageRootFromResolvedModule(path.join(packageRoot, "index.mjs"))).toBe(packageRoot);
  });
});
