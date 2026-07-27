import { describe, expect, it } from "bun:test";
import { createGiteaClient } from "../client.js";

describe("Gitea-compatible API client", () => {
  it("uses the Gitea Actions API URL when explicit Gitea URLs are absent", async () => {
    const requests: string[] = [];
    const client = createGiteaClient(
      {
        host: "gitea",
        env: {
          GITEA_TOKEN: "test-token",
          GITEA_ACTIONS: "true",
          GITHUB_API_URL: "https://gitea.example.com/api/v1",
        },
      },
      async (input) => {
        requests.push(String(input));
        return Response.json({ id: 9, login: "pipr-bot" });
      },
    );

    await expect(client.currentUser()).resolves.toEqual({ id: 9, login: "pipr-bot" });
    expect(requests).toEqual(["https://gitea.example.com/api/v1/user"]);
  });

  it("loads a Forgejo pull request through provider-neutral change coordinates", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const client = createGiteaClient(
      {
        host: "forgejo",
        env: {
          FORGEJO_TOKEN: "test-token",
          FORGEJO_SERVER_URL: "https://forge.example.com",
          FORGEJO_REPOSITORY: "acme/pipr",
        },
      },
      async (input, init) => {
        requests.push({
          url: String(input),
          authorization: new Headers(init?.headers).get("Authorization"),
        });
        return Response.json(pullRequest);
      },
    );

    await expect(
      client.loadChange({ owner: "acme", repository: "pipr", changeNumber: 7 }),
    ).resolves.toMatchObject({
      repository: { slug: "acme/pipr", url: "https://forge.example.com/acme/pipr" },
      coordinates: { provider: "gitea", owner: "acme", repository: "pipr" },
      change: {
        number: 7,
        title: "Add adapter",
        description: "Review this change.",
        base: { sha: "base", ref: "main" },
        head: { sha: "head", ref: "feature" },
        isFork: true,
        isDraft: false,
      },
    });
    expect(requests).toEqual([
      {
        url: "https://forge.example.com/api/v1/repos/acme/pipr/pulls/7",
        authorization: "token test-token",
      },
    ]);
  });

  it("maps native repository permissions", async () => {
    const responses = ["none", "read", "write", "admin", "owner"];
    const client = createGiteaClient(
      {
        host: "codeberg",
        env: { CODEBERG_TOKEN: "test-token" },
      },
      async () => Response.json({ permission: responses.shift() }),
    );

    await expect(client.getRepositoryPermission("acme", "pipr", "outsider")).resolves.toBe("none");
    await expect(client.getRepositoryPermission("acme", "pipr", "reader")).resolves.toBe("read");
    await expect(client.getRepositoryPermission("acme", "pipr", "writer")).resolves.toBe("write");
    await expect(client.getRepositoryPermission("acme", "pipr", "admin")).resolves.toBe("admin");
    await expect(client.getRepositoryPermission("acme", "pipr", "owner")).resolves.toBe("admin");
  });

  it("uses native issue-comment contracts for main review publication", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const responses: unknown[] = [
      { id: 9, login: "pipr-bot" },
      [],
      { id: 10, body: "created", user: { login: "pipr-bot" } },
      { id: 10, body: "updated", user: { login: "pipr-bot" } },
    ];
    const client = createGiteaClient(
      {
        host: "gitea",
        env: { GITEA_TOKEN: "test-token", GITEA_API_URL: "https://gitea.test/api/v1" },
      },
      async (input, init) => {
        requests.push({
          method: init?.method ?? "GET",
          path: `${new URL(String(input)).pathname}${new URL(String(input)).search}`,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json(responses.shift());
      },
    );

    await expect(client.currentUser()).resolves.toEqual({ id: 9, login: "pipr-bot" });
    await expect(client.listIssueComments("acme", "pipr", 7)).resolves.toEqual([]);
    await client.createIssueComment("acme", "pipr", 7, "created");
    await client.updateIssueComment("acme", "pipr", "10", "updated");

    expect(requests).toEqual([
      { method: "GET", path: "/api/v1/user" },
      { method: "GET", path: "/api/v1/repos/acme/pipr/issues/7/comments?page=1&limit=50" },
      {
        method: "POST",
        path: "/api/v1/repos/acme/pipr/issues/7/comments",
        body: { body: "created" },
      },
      {
        method: "PATCH",
        path: "/api/v1/repos/acme/pipr/issues/comments/10",
        body: { body: "updated" },
      },
    ]);
  });

  it("uses native review-comment and commit-status contracts", async () => {
    const requests: Array<{ method: string; path: string; body?: unknown }> = [];
    const responses: unknown[] = [
      [{ id: 3, user: { login: "pipr-bot" } }],
      [
        {
          id: 11,
          body: "inline",
          commit_id: "head",
          path: "src/a.ts",
          position: 4,
          original_position: 0,
          user: { login: "pipr-bot" },
        },
      ],
      { id: 4, user: { login: "pipr-bot" } },
      {
        id: 12,
        body: "reply",
        in_reply_to_id: 11,
        user: { login: "pipr-bot" },
      },
      { id: 99, context: "pipr/review", status: "success" },
    ];
    const client = createGiteaClient(
      { host: "codeberg", env: { CODEBERG_TOKEN: "test-token" } },
      async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          path: `${url.pathname}${url.search}`,
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return Response.json(responses.shift());
      },
    );

    await expect(client.listReviewComments("acme", "pipr", 7)).resolves.toMatchObject([
      {
        id: "11",
        body: "inline",
        authorLogin: "pipr-bot",
        path: "src/a.ts",
        commitId: "head",
        line: 4,
        side: "RIGHT",
      },
    ]);
    await client.createReviewComment("acme", "pipr", 7, {
      body: "new inline",
      path: "src/a.ts",
      commitId: "head",
      line: 5,
      side: "RIGHT",
    });
    await expect(client.replyToReviewComment("acme", "pipr", 7, "11", "reply")).resolves.toBe("12");
    await expect(
      client.setStatus("acme", "pipr", "head", "review", "success", "Done."),
    ).resolves.toBe("99");

    expect(requests).toEqual([
      { method: "GET", path: "/api/v1/repos/acme/pipr/pulls/7/reviews?page=1&limit=50" },
      { method: "GET", path: "/api/v1/repos/acme/pipr/pulls/7/reviews/3/comments" },
      {
        method: "POST",
        path: "/api/v1/repos/acme/pipr/pulls/7/reviews",
        body: {
          event: "COMMENT",
          commit_id: "head",
          comments: [{ body: "new inline", path: "src/a.ts", new_position: 5 }],
        },
      },
      {
        method: "POST",
        path: "/api/v1/repos/acme/pipr/pulls/7/comments/11/replies",
        body: { body: "reply" },
      },
      {
        method: "POST",
        path: "/api/v1/repos/acme/pipr/statuses/head",
        body: { context: "pipr/review", state: "success", description: "Done." },
      },
    ]);
  });
});

const pullRequest = {
  number: 7,
  title: "Add adapter",
  body: "Review this change.",
  html_url: "https://forge.example.com/acme/pipr/pulls/7",
  draft: false,
  user: { login: "contributor" },
  base: {
    ref: "main",
    sha: "base",
    repo: { id: 1, full_name: "acme/pipr", html_url: "https://forge.example.com/acme/pipr" },
  },
  head: {
    ref: "feature",
    sha: "head",
    repo: {
      id: 2,
      full_name: "contributor/pipr",
      html_url: "https://forge.example.com/contributor/pipr",
    },
  },
};
