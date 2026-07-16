import { describe, expect, it } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeRequestEventContext } from "../../../types.js";
import { ensureAzureDevOpsHeadCheckout } from "../workspace.js";

describe("Azure DevOps workspace checkout", () => {
  it("fetches the source branch and detaches at the exact reviewed SHA", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-azure-workspace-"));
    const origin = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const workspace = path.join(root, "workspace");
    try {
      git(root, ["init", "--bare", origin]);
      git(root, ["init", seed]);
      git(seed, ["config", "user.name", "Pipr Test"]);
      git(seed, ["config", "user.email", "pipr@example.test"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 1;\n");
      git(seed, ["add", "fixture.ts"]);
      git(seed, ["commit", "-m", "base"]);
      const baseSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["branch", "-M", "main"]);
      git(seed, ["remote", "add", "origin", origin]);
      git(seed, ["push", "origin", "main"]);
      git(seed, ["switch", "-c", "feature"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 2;\n");
      git(seed, ["commit", "-am", "head"]);
      const headSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["push", "origin", "feature"]);
      git(root, ["clone", "--branch", "main", origin, workspace]);

      await ensureAzureDevOpsHeadCheckout({ rootDir: workspace, change: changeAt(headSha) });
      expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headSha);
      expect(git(workspace, ["merge-base", baseSha, headSha]).trim()).toBe(baseSha);

      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 3;\n");
      git(seed, ["commit", "-am", "updated head"]);
      const updatedHeadSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["push", "origin", "feature"]);
      await ensureAzureDevOpsHeadCheckout({
        rootDir: workspace,
        change: changeAt(updatedHeadSha),
      });
      expect(git(workspace, ["merge-base", baseSha, updatedHeadSha]).trim()).toBe(baseSha);

      await rename(origin, `${origin}.offline`);
      await expect(
        ensureAzureDevOpsHeadCheckout({ rootDir: workspace, change: changeAt(updatedHeadSha) }),
      ).resolves.toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fetches a fork pull request from its source repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-azure-fork-workspace-"));
    const target = path.join(root, "target.git");
    const fork = path.join(root, "fork.git");
    const seed = path.join(root, "seed");
    const workspace = path.join(root, "workspace");
    try {
      git(root, ["init", "--bare", target]);
      git(root, ["init", "--bare", fork]);
      git(root, ["init", seed]);
      git(seed, ["config", "user.name", "Pipr Test"]);
      git(seed, ["config", "user.email", "pipr@example.test"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 1;\n");
      git(seed, ["add", "fixture.ts"]);
      git(seed, ["commit", "-m", "base"]);
      git(seed, ["branch", "-M", "main"]);
      git(seed, ["remote", "add", "target", target]);
      git(seed, ["push", "target", "main"]);
      git(seed, ["switch", "-c", "feature"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 2;\n");
      git(seed, ["commit", "-am", "fork head"]);
      const headSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["remote", "add", "fork", fork]);
      git(seed, ["push", "fork", "feature"]);
      git(root, ["clone", "--branch", "main", target, workspace]);

      await ensureAzureDevOpsHeadCheckout({
        rootDir: workspace,
        change: changeAt(headSha, { isFork: true, headUrl: fork }),
      });
      expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headSha);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function changeAt(
  headSha: string,
  options: { isFork?: boolean; headUrl?: string } = {},
): ChangeRequestEventContext {
  return {
    eventName: "azure_pipeline",
    platform: { id: "azure-devops" },
    repository: { slug: "org/project/repository" },
    change: {
      number: 7,
      title: "Test PR",
      description: "",
      base: { sha: "base", ref: "main" },
      head: { sha: headSha, ref: "feature", ...(options.headUrl ? { url: options.headUrl } : {}) },
      ...(options.isFork ? { isFork: true } : {}),
    },
    workspace: "/workspace",
  };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
