import { describe, expect, it } from "bun:test";
import { createBitbucketClient } from "../client.js";

describe("Bitbucket Cloud client", () => {
  it("loads exact pull request coordinates and fork metadata", async () => {
    const client = createBitbucketClient(env, async () => Response.json(pullRequest));
    await expect(
      client.loadChange({ workspace: "workspace", repository: "repository", changeNumber: 7 }),
    ).resolves.toMatchObject({
      coordinates: {
        provider: "bitbucket",
        workspace: "workspace",
        repository: "repository",
        repositoryUuid: "{target-repo}",
      },
      change: {
        number: 7,
        base: { sha: "base", ref: "main" },
        head: { sha: "head", ref: "feature" },
        isFork: true,
      },
    });
  });

  it("follows opaque comment pages", async () => {
    const requests: string[] = [];
    const client = createBitbucketClient(env, async (input) => {
      const url = String(input);
      requests.push(url);
      return url.includes("page=2")
        ? Response.json({ values: [{ id: 2, content: { raw: "second" } }] })
        : Response.json({
            values: [{ id: 1, content: { raw: "first" } }],
            next: "https://api.bitbucket.org/2.0/repositories/workspace/repository/pullrequests/7/comments?page=2",
          });
    });
    await expect(client.listComments(7)).resolves.toHaveLength(2);
    expect(requests[1]).toContain("page=2");
  });

  it("uses native comment and status contracts", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createBitbucketClient(env, async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.endsWith("/comments"))
        return Response.json({
          id: 3,
          content: { raw: "inline" },
          inline: { path: "a.ts", to: 2 },
        });
      if (url.includes("/statuses/build/")) return Response.json({ key: "pipr-review" });
      return Response.json({ id: 1, content: { raw: "updated" } });
    });

    await client.createComment(7, { content: { raw: "inline" }, inline: { path: "a.ts", to: 2 } });
    await client.updateComment(7, "1", "updated");
    await client.replyToComment(7, "1", "reply");
    await client.resolveComment(7, "1");
    await client.setStatus("head", "pipr-review", { state: "SUCCESSFUL" });

    expect(requests.map((request) => request.method)).toContain("PUT");
    expect(requests.some((request) => request.url.endsWith("/resolve"))).toBe(true);
    expect(requests.some((request) => request.url.includes("/statuses/build/pipr-review"))).toBe(
      true,
    );
  });

  it("maps effective workspace repository permissions", async () => {
    const client = createBitbucketClient(env, async (input) =>
      String(input).includes("permissions/repositories")
        ? Response.json({ values: [{ permission: "admin", user: { nickname: "maintainer" } }] })
        : Response.json({}),
    );
    await expect(client.getRepositoryPermission("maintainer", "{target-repo}")).resolves.toBe(
      "admin",
    );
  });
});

const env = {
  BITBUCKET_WORKSPACE: "workspace",
  BITBUCKET_REPO_SLUG: "repository",
  BITBUCKET_TOKEN: "token",
};

const repository = (uuid: string, fullName: string) => ({
  uuid,
  name: fullName.split("/")[1],
  slug: fullName.split("/")[1],
  full_name: fullName,
  links: { html: { href: `https://bitbucket.org/${fullName}` } },
});

const pullRequest = {
  id: 7,
  title: "Update fixture",
  description: "Body",
  author: { nickname: "developer" },
  source: {
    branch: { name: "feature" },
    commit: { hash: "head" },
    repository: repository("{source-repo}", "fork/repository"),
  },
  destination: {
    branch: { name: "main" },
    commit: { hash: "base" },
    repository: repository("{target-repo}", "workspace/repository"),
  },
  links: { html: { href: "https://bitbucket.org/workspace/repository/pull-requests/7" } },
};
