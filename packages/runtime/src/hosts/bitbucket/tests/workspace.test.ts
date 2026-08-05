import { describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeRequestEventContext } from "../../../types.js";
import { ensureBitbucketHeadCheckout } from "../workspace.js";

describe("Bitbucket Cloud workspace", () => {
  it("fetches an exact private-fork head with an origin-scoped API-token header", async () => {
    const fixture = await createFixture();
    try {
      const remote = "https://bitbucket.org/workspace/repository";
      await ensureBitbucketHeadCheckout({
        rootDir: fixture.checkout,
        change: change(remote, fixture.head, true),
        env: fixture.env,
      });
      expect(git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.head);
      const log = await Bun.file(fixture.log).text();
      expect(log).toContain(remote);
      expect(log).toContain("1|http.https://bitbucket.org/.extraHeader|basic|");
      expect(log).not.toContain("|http.extraHeader|");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "",
    "not a URL",
    "http://bitbucket.org/workspace/repository",
    "https://user:password@bitbucket.org/workspace/repository",
    "https://bitbucket.org.attacker.example/workspace/repository",
    "https://example.com/workspace/repository",
    "https://bitbucket.org/workspace/repository?token=value",
    "https://bitbucket.org/workspace/repository#fragment",
    "https://bitbucket.org/",
    "https://bitbucket.org//",
  ])("rejects the untrusted Cloud fork URL %s before Git runs", async (remote) => {
    const fixture = await createFixture();
    try {
      let error: unknown;
      try {
        await ensureBitbucketHeadCheckout({
          rootDir: fixture.checkout,
          change: change(remote, fixture.head, true),
          env: fixture.env,
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("Bitbucket Cloud fork URL");
      expect(String(error)).not.toContain("token");
      expect(String(error)).not.toContain("Authorization");
      expect(await Bun.file(fixture.log).exists()).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("validates public fork remotes without attaching an authorization header", async () => {
    const fixture = await createFixture();
    try {
      const remote = "https://bitbucket.org/workspace/repository";
      const env: NodeJS.ProcessEnv = { ...fixture.env };
      delete env.BITBUCKET_API_TOKEN;
      await ensureBitbucketHeadCheckout({
        rootDir: fixture.checkout,
        change: change(remote, fixture.head, true),
        env,
      });
      expect(git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.head);
      const log = await Bun.file(fixture.log).text();
      expect(log).toContain(remote);
      expect(log).not.toContain("extraHeader");
      expect(log).not.toMatch(/\|(basic|bearer)\|/);
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
      expect(log).not.toContain("extraHeader");
      expect(log).not.toMatch(/\|(basic|bearer)\|/);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("fetches Data Center private forks with context-scoped bearer authentication", async () => {
    const fixture = await createFixture();
    try {
      const remote = "https://bitbucket.example.com/context/scm/DEV/repository.git";
      await ensureBitbucketHeadCheckout({
        rootDir: fixture.checkout,
        change: change(remote, fixture.head, true),
        env: {
          ...fixture.env,
          BITBUCKET_BASE_URL: "https://bitbucket.example.com/context/",
          BITBUCKET_TOKEN: "data-center-token",
        },
      });
      expect(git(fixture.checkout, ["rev-parse", "HEAD"])).toBe(fixture.head);
      const log = await Bun.file(fixture.log).text();
      expect(log).toContain(remote);
      expect(log).toContain("1|http.https://bitbucket.example.com/context/.extraHeader|bearer|");
      expect(log).not.toContain("|http.extraHeader|");
      expect(log).not.toContain("basic");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it.each([
    "https://bitbucket.example.com/scm/DEV/repository.git",
    "https://other.example.com/context/scm/DEV/repository.git",
  ])("rejects the untrusted Data Center fork URL %s before Git runs", async (remote) => {
    const fixture = await createFixture();
    try {
      let error: unknown;
      try {
        await ensureBitbucketHeadCheckout({
          rootDir: fixture.checkout,
          change: change(remote, fixture.head, true),
          env: {
            ...fixture.env,
            BITBUCKET_BASE_URL: "https://bitbucket.example.com/context",
            BITBUCKET_TOKEN: "data-center-token",
          },
        });
      } catch (caught) {
        error = caught;
      }
      expect(String(error)).toContain("Bitbucket Data Center fork URL");
      expect(String(error)).not.toContain("data-center-token");
      expect(String(error)).not.toContain("Authorization");
      expect(await Bun.file(fixture.log).exists()).toBe(false);
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
  git(checkout, [
    "config",
    "--add",
    `url.${remote}.insteadOf`,
    "https://bitbucket.org/workspace/repository",
  ]);
  git(checkout, [
    "config",
    "--add",
    `url.${remote}.insteadOf`,
    "https://bitbucket.example.com/context/scm/DEV/repository.git",
  ]);
  await Bun.write(path.join(checkout, "base.txt"), "base\n");
  git(checkout, ["add", "base.txt"]);
  git(checkout, ["commit", "-m", "base"]);

  const wrapper = path.join(bin, "git");
  await Bun.write(
    wrapper,
    '#!/bin/sh\nauth=none\ncase "$GIT_CONFIG_VALUE_0" in\n  "Authorization: Basic "*) auth=basic ;;\n  "Authorization: Bearer "*) auth=bearer ;;\nesac\nprintf "%s|%s|%s|" "$GIT_CONFIG_COUNT" "$GIT_CONFIG_KEY_0" "$auth" >> "$PIPR_GIT_LOG"\nprintf "%s\\n" "$*" >> "$PIPR_GIT_LOG"\nexec "$PIPR_REAL_GIT" "$@"\n',
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
