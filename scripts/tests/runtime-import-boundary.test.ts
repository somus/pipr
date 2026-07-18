import { describe, expect, it } from "bun:test";
import path from "node:path";
import {
  checkRuntimeImportBoundary,
  forbiddenRuntimeImports,
} from "../check-runtime-import-boundary.ts";

const repoRoot = path.resolve(import.meta.dirname, "../..");

describe("runtime review import boundary", () => {
  it("keeps provider-specific imports out of core review orchestration", async () => {
    expect(await checkRuntimeImportBoundary(repoRoot)).toEqual([]);
  });

  it("detects module specifiers while ignoring comments and ordinary strings", () => {
    expect(forbiddenRuntimeImports('import "../../hosts/github/client";', "bad.ts")).toEqual([
      "bad.ts:1: forbidden provider import '../../hosts/github/client'",
    ]);
    expect(
      forbiddenRuntimeImports(
        '// import "../../hosts/github/client"\nconst example = "@octokit/rest";',
      ),
    ).toEqual([]);
  });
});
