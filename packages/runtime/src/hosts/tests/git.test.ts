import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureCodeHostCommit, ensureCodeHostHeadCheckout } from "../git.js";

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

  it("checks out the reviewed SHA when the remote ref has advanced", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-code-host-git-"));
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const workspace = path.join(root, "workspace");
    try {
      git(root, ["init", "--bare", remote]);
      git(root, ["init", seed]);
      git(seed, ["config", "user.name", "Pipr Test"]);
      git(seed, ["config", "user.email", "pipr@example.test"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 1;\n");
      git(seed, ["add", "fixture.ts"]);
      git(seed, ["commit", "-m", "reviewed head"]);
      const reviewedSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["push", remote, "HEAD:refs/heads/feature"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 2;\n");
      git(seed, ["commit", "-am", "advanced head"]);
      git(seed, ["push", remote, "HEAD:refs/heads/feature"]);
      git(root, ["init", workspace]);
      git(workspace, ["config", "user.name", "Pipr Test"]);
      git(workspace, ["config", "user.email", "pipr@example.test"]);
      await Bun.write(path.join(workspace, "base.ts"), "export const base = true;\n");
      git(workspace, ["add", "base.ts"]);
      git(workspace, ["commit", "-m", "base"]);
      git(workspace, ["remote", "add", "origin", remote]);

      await ensureCodeHostHeadCheckout({
        rootDir: workspace,
        headSha: reviewedSha,
        fetchRef: "refs/heads/feature",
      });

      expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(reviewedSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches an advanced trusted base without changing the checkout", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-code-host-git-"));
    const remote = path.join(root, "remote.git");
    const seed = path.join(root, "seed");
    const workspace = path.join(root, "workspace");
    try {
      git(root, ["init", "--bare", remote]);
      git(root, ["init", seed]);
      git(seed, ["config", "user.name", "Pipr Test"]);
      git(seed, ["config", "user.email", "pipr@example.test"]);
      await Bun.write(path.join(seed, "config.ts"), "export const check = false;\n");
      git(seed, ["add", "config.ts"]);
      git(seed, ["commit", "-m", "initial trusted base"]);
      const initialSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["push", remote, "HEAD:refs/heads/main"]);
      git(root, ["clone", "--branch", "main", remote, workspace]);

      await Bun.write(path.join(seed, "config.ts"), "export const check = true;\n");
      git(seed, ["commit", "-am", "advance trusted base"]);
      const advancedSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["push", remote, "HEAD:refs/heads/main"]);

      await ensureCodeHostCommit({
        rootDir: workspace,
        commitSha: advancedSha,
        fetchRef: "refs/heads/main",
      });

      expect(git(workspace, ["cat-file", "-e", `${advancedSha}^{commit}`])).toBe("");
      expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(initialSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
