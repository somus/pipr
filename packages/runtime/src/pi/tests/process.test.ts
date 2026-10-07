import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPiRunSandbox, removeSandboxRoot } from "../process.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Pi run sandbox", () => {
  it("copies the workspace without any .git directory or gitfile at any depth", async () => {
    const source = await mkdtemp(path.join(os.tmpdir(), "pipr-sandbox-source-"));
    cleanups.push(() => rm(source, { recursive: true, force: true }));
    const files: Record<string, string> = {
      ".git/config": "top",
      "sub/.git/config": "nested",
      "vendor/lib/.git": "gitdir: ../../.git/modules/lib",
      "sub/src/app.ts": "app",
      "vendor/lib/index.ts": "lib",
      "node_modules/pkg/index.js": "dependency",
      "packages/a/.gitignore": "keep",
    };
    for (const [relative, contents] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(source, relative)), { recursive: true });
      await writeFile(path.join(source, relative), contents);
    }

    const sandbox = await createPiRunSandbox(source);
    cleanups.push(() => removeSandboxRoot(sandbox.root));

    const copied = (await readdir(sandbox.workspace, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .relative(sandbox.workspace, path.join(entry.parentPath, entry.name))
          .split(path.sep)
          .join("/"),
      )
      .sort();
    expect(copied).toEqual(["packages/a/.gitignore", "sub/src/app.ts", "vendor/lib/index.ts"]);
  });
});
