import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
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
    for (const provider of ["azure-devops", "bitbucket", "github", "gitlab", "local"]) {
      expect(
        forbiddenRuntimeImports(`import "../../hosts/${provider}/adapter";`, "bad.ts"),
      ).toEqual([`bad.ts:1: forbidden provider import '../../hosts/${provider}/adapter'`]);
    }
    expect(forbiddenRuntimeImports('import type { Host } from "../../hosts/types";')).toEqual([]);
    expect(
      forbiddenRuntimeImports(
        '// import "../../hosts/github/client"\nconst example = "@octokit/rest";',
      ),
    ).toEqual([]);
  });

  it("checks production files without applying the boundary to test fixtures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-runtime-boundary-"));
    const reviewRoot = path.join(root, "packages/runtime/src/review");
    await mkdir(path.join(reviewRoot, "tests"), { recursive: true });
    await writeFile(path.join(reviewRoot, "review.ts"), 'import "../hosts/github/adapter";\n');
    await writeFile(
      path.join(reviewRoot, "tests/provider-fixture.ts"),
      'import "../../hosts/github/adapter";\n',
    );

    try {
      const violations = await checkRuntimeImportBoundary(root);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain("review.ts:1: forbidden provider import");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
