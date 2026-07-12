import { describe, expect, it } from "bun:test";
import { mkdtemp, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeRequestEventContext } from "../../../types.js";
import { ensureGitLabHeadCheckout } from "../workspace.js";

describe("GitLab workspace checkout", () => {
  it("fetches the merge-request head ref and detaches at the exact SHA", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-gitlab-workspace-"));
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
      git(seed, ["branch", "-M", "main"]);
      git(seed, ["remote", "add", "origin", origin]);
      git(seed, ["push", "origin", "main"]);
      await Bun.write(path.join(seed, "fixture.ts"), "export const value = 2;\n");
      git(seed, ["commit", "-am", "head"]);
      const headSha = git(seed, ["rev-parse", "HEAD"]).trim();
      git(seed, ["push", "origin", `HEAD:refs/merge-requests/7/head`]);
      git(root, ["clone", "--branch", "main", origin, workspace]);

      ensureGitLabHeadCheckout({ rootDir: workspace, change: changeAt(headSha) });
      expect(git(workspace, ["rev-parse", "HEAD"]).trim()).toBe(headSha);

      await rename(origin, `${origin}.offline`);
      expect(() =>
        ensureGitLabHeadCheckout({ rootDir: workspace, change: changeAt(headSha) }),
      ).not.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function changeAt(headSha: string): ChangeRequestEventContext {
  return {
    eventName: "merge_request",
    platform: { id: "gitlab" },
    repository: { slug: "group/project" },
    change: {
      number: 7,
      title: "Test MR",
      description: "",
      base: { sha: "base", ref: "main" },
      head: { sha: headSha, ref: "feature" },
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
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }
  return result.stdout.toString();
}
