import { describe, expect, it } from "bun:test";
import { createBitbucketClient } from "../client.js";

describe("Bitbucket Data Center client", () => {
  it("loads repository identity through the Data Center project API", async () => {
    const requests: string[] = [];
    const client = createBitbucketClient(
      { ...env, BITBUCKET_BASE_URL: "https://bitbucket.example.com/context" },
      async (input) => {
        requests.push(String(input));
        return Response.json(repository(42, "PRJ", "pipr"));
      },
    );

    await expect(client.getRepository()).resolves.toEqual({
      uuid: "42",
      slug: "pipr",
      fullName: "PRJ/pipr",
      url: "https://bitbucket.example.com/context/projects/PRJ/repos/pipr/browse",
    });
    expect(requests).toEqual([
      "https://bitbucket.example.com/context/rest/api/latest/projects/PRJ/repos/pipr",
    ]);
  });

  it("loads pull requests through the Data Center project API", async () => {
    const requests: string[] = [];
    const client = createBitbucketClient(env, async (input, init) => {
      requests.push(String(input));
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer review-token");
      return Response.json(pullRequest);
    });

    await expect(
      client.loadChange({ workspace: "PRJ", repository: "pipr", changeNumber: 7 }),
    ).resolves.toMatchObject({
      repository: {
        slug: "PRJ/pipr",
        url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/browse",
      },
      coordinates: {
        provider: "bitbucket",
        workspace: "PRJ",
        repository: "pipr",
        repositoryUuid: "42",
      },
      change: {
        number: 7,
        title: "Data Center change",
        author: { login: "developer" },
        base: { sha: "base", ref: "main" },
        head: { sha: "head", ref: "feature" },
        isFork: true,
      },
    });
    expect(requests).toEqual([
      "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7",
    ]);
  });

  it("maps Data Center comments, multiline anchors, updates, replies, and statuses", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const client = createBitbucketClient(env, async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ url, method, body });
      return dataCenterResponse(url, method);
    });

    await expect(client.listComments(7)).resolves.toMatchObject([
      {
        id: "11",
        content: { raw: "existing" },
        user: { uuid: "pipr-bot", nickname: "pipr-bot" },
        inline: {
          path: "src/a.ts",
          src_path: "src/old.ts",
          from: 4,
          start_from: 2,
        },
        resolution: {},
      },
      {
        id: "13",
        content: { raw: "reply" },
        parent: { id: "11" },
      },
      {
        id: "14",
        content: { raw: "file-level" },
        inline: undefined,
      },
    ]);
    await client.createComment(7, {
      content: { raw: "inline" },
      inline: { path: "src/a.ts", to: 4, start_to: 2 },
    });
    await client.createComment(7, {
      content: { raw: "renamed" },
      inline: {
        path: "src/new.ts",
        src_path: "src/old.ts",
        from: 6,
        start_from: 5,
      },
    });
    await client.updateComment(7, "11", "updated");
    await client.replyToComment(7, "11", "reply");
    await client.resolveComment(7, "11");
    await client.setStatus("head", "pipr-review", {
      state: "SUCCESSFUL",
      name: "Pipr: review",
      description: "Passed",
      refname: "feature",
      url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/pull-requests/7",
    });
    await client.setStatus("head", "pipr-review", {
      state: "STOPPED",
      name: "Pipr: review",
      description: "Neutral",
      refname: "feature",
      url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/pull-requests/7",
    });

    expect(requests).toContainEqual({
      url: "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/comments",
      method: "POST",
      body: {
        text: "inline",
        anchor: {
          diffType: "COMMIT",
          fileType: "TO",
          fromHash: "base",
          toHash: "head",
          line: 4,
          lineType: "ADDED",
          path: "src/a.ts",
          multilineMarker: { startLine: 2, startLineType: "ADDED" },
        },
      },
    });
    expect(requests).toContainEqual({
      url: "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/comments",
      method: "POST",
      body: {
        text: "renamed",
        anchor: {
          diffType: "COMMIT",
          fileType: "FROM",
          fromHash: "base",
          toHash: "head",
          line: 6,
          lineType: "REMOVED",
          path: "src/new.ts",
          srcPath: "src/old.ts",
          multilineMarker: { startLine: 5, startLineType: "REMOVED" },
        },
      },
    });
    expect(requests).toContainEqual({
      url: "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/comments/11",
      method: "PUT",
      body: { text: "updated", version: 2 },
    });
    expect(requests).toContainEqual({
      url: "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/comments/11",
      method: "PUT",
      body: { version: 2, threadResolved: true },
    });
    expect(requests).toContainEqual({
      url: "https://bitbucket.example.com/rest/build-status/latest/commits/head",
      method: "POST",
      body: {
        state: "SUCCESSFUL",
        key: "pipr-review",
        name: "Pipr: review",
        description: "Passed",
        ref: "feature",
        url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/pull-requests/7",
      },
    });
    expect(requests).toContainEqual({
      url: "https://bitbucket.example.com/rest/build-status/latest/commits/head",
      method: "POST",
      body: {
        state: "CANCELLED",
        key: "pipr-review",
        name: "Pipr: review",
        description: "Neutral",
        ref: "feature",
        url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/pull-requests/7",
      },
    });
  });

  it("uses the separate administrator token for effective permission filters", async () => {
    const authorizations: string[] = [];
    const urls: string[] = [];
    const client = createBitbucketClient(
      { ...env, BITBUCKET_PERMISSION_TOKEN: "permission-token" },
      async (input, init) => {
        const url = String(input);
        urls.push(url);
        authorizations.push(new Headers(init?.headers).get("Authorization") ?? "");
        return Response.json({
          values: url.includes("REPO_WRITE") ? [{ name: "maintainer", slug: "maintainer" }] : [],
          isLastPage: true,
        });
      },
    );

    await expect(client.getRepositoryPermission("maintainer", "42")).resolves.toBe("write");
    expect(authorizations).toEqual(["Bearer permission-token", "Bearer permission-token"]);
    expect(urls[0]).toContain("permission.0=REPO_ADMIN");
    expect(urls[1]).toContain("permission.0=REPO_WRITE");
  });

  it("paginates Data Center activities with nextPageStart", async () => {
    const urls: string[] = [];
    const client = createBitbucketClient(env, async (input) => {
      const url = String(input);
      urls.push(url);
      const start = new URL(url).searchParams.get("start");
      return Response.json({
        values: [
          {
            action: "COMMENTED",
            comment: {
              id: start ? 22 : 21,
              version: 0,
              text: start ? "second" : "first",
            },
          },
        ],
        isLastPage: Boolean(start),
        ...(start ? {} : { nextPageStart: 25 }),
      });
    });

    await expect(client.listComments(7)).resolves.toMatchObject([
      { id: "21", content: { raw: "first" } },
      { id: "22", content: { raw: "second" } },
    ]);
    expect(urls).toEqual([
      "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/activities?limit=100",
      "https://bitbucket.example.com/rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/activities?limit=100&start=25",
    ]);
  });

  it("rejects unsafe Data Center base URLs before sending credentials", () => {
    for (const baseUrl of [
      "http://bitbucket.example.com",
      "https://user:secret@bitbucket.example.com",
      "https://bitbucket.example.com?token=secret",
    ]) {
      expect(() => createBitbucketClient({ ...env, BITBUCKET_BASE_URL: baseUrl })).toThrow(
        "Bitbucket Data Center base URL must be an HTTPS URL without credentials",
      );
    }
  });
});

function dataCenterResponse(url: string, method: string): Response {
  const parsed = new URL(url);
  const key = `${method} ${parsed.pathname}${parsed.search}`;
  return dataCenterResponses.get(key)?.() ?? Response.json({ id: 12, version: 3, text: "written" });
}

const dataCenterResponses = new Map<string, () => Response>([
  [
    "GET /rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7",
    () => Response.json(pullRequest),
  ],
  [
    "GET /rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/activities?limit=100",
    () =>
      Response.json({
        values: [
          {
            action: "COMMENTED",
            commentAnchor: {
              path: "src/a.ts",
              srcPath: "src/old.ts",
              line: 4,
              fileType: "FROM",
              multilineMarker: { startLine: 2, startLineType: "REMOVED" },
            },
            comment: {
              id: 11,
              version: 2,
              text: "existing",
              author: { name: "pipr-bot", slug: "pipr-bot" },
              threadResolved: true,
              comments: [
                {
                  id: 13,
                  version: 0,
                  text: "reply",
                  parent: { id: 11 },
                  author: { name: "developer", slug: "developer" },
                },
              ],
            },
          },
          {
            action: "COMMENTED",
            commentAnchor: {
              path: "src/file.ts",
              fromHash: "base",
              toHash: "head",
            },
            comment: {
              id: 14,
              version: 0,
              text: "file-level",
              author: { name: "developer", slug: "developer" },
            },
          },
        ],
        isLastPage: true,
      }),
  ],
  [
    "GET /rest/api/latest/projects/PRJ/repos/pipr/pull-requests/7/comments/11",
    () => Response.json({ id: 11, version: 2, text: "existing" }),
  ],
  ["POST /rest/build-status/latest/commits/head", () => new Response(null, { status: 204 })],
]);

const env = {
  BITBUCKET_BASE_URL: "https://bitbucket.example.com",
  BITBUCKET_PROJECT_KEY: "PRJ",
  BITBUCKET_REPO_SLUG: "pipr",
  BITBUCKET_TOKEN: "review-token",
  BITBUCKET_USER: "pipr-bot",
};

const repository = (id: number, projectKey: string, slug: string) => ({
  id,
  name: slug,
  slug,
  project: { key: projectKey },
});

const pullRequest = {
  id: 7,
  draft: false,
  title: "Data Center change",
  description: "Body",
  author: { user: { name: "developer", slug: "developer" } },
  fromRef: {
    id: "refs/heads/feature",
    displayId: "feature",
    latestCommit: "head",
    repository: repository(84, "~DEVELOPER", "pipr"),
  },
  toRef: {
    id: "refs/heads/main",
    displayId: "main",
    latestCommit: "base",
    repository: repository(42, "PRJ", "pipr"),
  },
  links: {
    self: [
      {
        href: "https://bitbucket.example.com/projects/PRJ/repos/pipr/pull-requests/7/overview",
      },
    ],
  },
};
