import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureCodeHostHeadCheckout } from "../git.js";

describe("code host checkout", () => {
  it("keeps the event loop responsive while git fetch is running", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-code-host-git-"));
    const bin = path.join(root, "bin");
    const workspace = path.join(root, "workspace");
    try {
      await mkdir(bin);
      await mkdir(workspace);
      await Bun.$`git init ${workspace}`.quiet();
      const fakeGit = path.join(bin, "git");
      await Bun.write(fakeGit, "#!/bin/sh\nsleep 0.2\necho delayed fetch failed >&2\nexit 1\n");
      await chmod(fakeGit, 0o755);
      await Bun.$`git -C ${workspace} remote add origin ssh://example.invalid/repository`;
      await Bun.$`git -C ${workspace} config core.sshCommand ${fakeGit}`;

      let settled = false;
      const checkout = ensureCodeHostHeadCheckout({
        rootDir: workspace,
        headSha: "0000000000000000000000000000000000000001",
        fetchRef: "refs/heads/feature",
      }).finally(() => {
        settled = true;
      });

      await Bun.sleep(20);
      expect(settled).toBe(false);
      await expect(checkout).rejects.toThrow("delayed fetch failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
