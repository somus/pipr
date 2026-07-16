import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeRequestEventContext } from "../../../types.js";
import { ensureBitbucketHeadCheckout } from "../workspace.js";

describe("Bitbucket Cloud workspace", () => {
  it("fetches an exact private-fork head with an API-token header", async () => {
    const fixture = await createFixture();
    try {
      await ensureBitbucketHeadCheckout({
        rootDir: fixture.checkout,
        change: change(fixture.remote, fixture.head, true),
        env: fixture.env,
      });
      expect(git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.head);
      const log = await Bun.file(fixture.log).text();
      expect(log).toContain(fixture.remote);
      expect(log).toContain(
        `Authorization: Basic ${Buffer.from("x-bitbucket-api-token-auth:token").toString("base64")}`,
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not attach the API-token header to same-repository fetches", async () => {
    const fixture = await createFixture();
    try {
      git(fixture.checkout, ["remote", "add", "origin", fixture.remote]);
      await ensureBitbucketHeadCheckout({
        rootDir: fixture.checkout,
        change: change("https://bitbucket.org/workspace/repository", fixture.head, false),
        env: fixture.env,
      });
      expect(git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.head);
      const log = await Bun.file(fixture.log).text();
      expect(log).toContain(`fetch --no-tags origin ${fixture.head}`);
      expect(log).not.toContain("Authorization: Basic");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-workspace-"));
  const source = path.join(root, "source");
  const remote = path.join(root, "fork.git");
  const checkout = path.join(root, "checkout");
  const bin = path.join(root, "bin");
  const log = path.join(root, "git.log");
  await mkdir(source);
  await mkdir(checkout);
  await mkdir(bin);
  git(source, ["init"]);
  git(source, ["config", "user.email", "pipr@example.com"]);
  git(source, ["config", "user.name", "Pipr"]);
  await Bun.write(path.join(source, "fixture.txt"), "head\n");
  git(source, ["add", "fixture.txt"]);
  git(source, ["commit", "-m", "fixture"]);
  git(source, ["branch", "-M", "feature"]);
  const head = git(source, ["rev-parse", "HEAD"]);
  git(root, ["clone", "--bare", source, remote]);
  git(checkout, ["init"]);
  git(checkout, ["config", "user.email", "pipr@example.com"]);
  git(checkout, ["config", "user.name", "Pipr"]);
  await Bun.write(path.join(checkout, "base.txt"), "base\n");
  git(checkout, ["add", "base.txt"]);
  git(checkout, ["commit", "-m", "base"]);

  const wrapper = path.join(bin, "git");
  await Bun.write(
    wrapper,
    '#!/bin/sh\nprintf "%s|%s|%s|" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" >> "$PIPR_GIT_LOG"\nprintf "%s\\n" "$*" >> "$PIPR_GIT_LOG"\nexec "$PIPR_REAL_GIT" "$@"\n',
  );
  await chmod(wrapper, 0o700);
  return {
    root,
    remote,
    checkout,
    head,
    log,
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PIPR_REAL_GIT: "/usr/bin/git",
      PIPR_GIT_LOG: log,
      BITBUCKET_API_TOKEN: "token",
    },
  };
}

function git(cwd: string, args: string[]) {
  const result = Bun.spawnSync(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function change(url: string, sha: string, isFork: boolean): ChangeRequestEventContext {
  return {
    eventName: "pullrequest:updated",
    platform: { id: "bitbucket" },
    repository: { slug: "workspace/repository" },
    change: {
      number: 7,
      title: "PR",
      description: "",
      base: { sha: "base", ref: "main" },
      head: { sha, ref: "feature", url },
      isFork,
    },
    workspace: "/workspace",
  };
}
