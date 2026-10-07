import { describe, expect, it } from "bun:test";
import { createGitHubCommandClient, createGitHubPublicationClient } from "../client.js";

describe("GitHub client", () => {
  it("loads pull request details into provider-neutral change refs", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = requestUrl(input);
        expect(url.pathname).toBe("/repos/fallback/repo/pulls/7");
        return Response.json({
          title: "Adapter seam",
          body: null,
          html_url: "https://github.test/local/pipr/pull/7",
          user: { login: "author" },
          base: {
            sha: "base-sha",
            ref: "main",
            repo: {
              full_name: "local/pipr",
              html_url: "https://github.test/local/pipr",
            },
          },
          head: {
            sha: "head-sha",
            ref: "feature",
            repo: {
              full_name: "contributor/pipr",
              html_url: "https://github.test/contributor/pipr",
              fork: true,
            },
            user: { login: "contributor" },
          },
        });
      }) as unknown as typeof fetch;

      const client = createGitHubCommandClient({
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_TOKEN: "token",
      });

      await expect(
        client.getPullRequest({
          repository: { slug: "fallback/repo" },
          changeNumber: 7,
        }),
      ).resolves.toEqual({
        repository: {
          slug: "local/pipr",
          url: "https://github.test/local/pipr",
        },
        change: {
          number: 7,
          title: "Adapter seam",
          description: "",
          url: "https://github.test/local/pipr/pull/7",
          author: { login: "author" },
          base: {
            sha: "base-sha",
            ref: "main",
            url: "https://github.test/local/pipr",
          },
          head: {
            sha: "head-sha",
            ref: "feature",
            url: "https://github.test/contributor/pipr",
            author: { login: "contributor" },
            fork: true,
          },
          isFork: true,
        },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("normalizes GitHub collaborator permission payloads", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
        const url = requestUrl(input);
        expect(url.pathname).toBe("/repos/local/pipr/collaborators/somu/permission");
        return Response.json({ permission: "write", role_name: "maintain" });
      }) as unknown as typeof fetch;

      const client = createGitHubCommandClient({
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_TOKEN: "token",
      });

      await expect(
        client.getRepositoryPermission({
          repository: { slug: "local/pipr" },
          actor: "somu",
        }),
      ).resolves.toBe("maintain");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps missing collaborators to no repository permission", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        new Response("{}", { status: 404 })) as unknown as typeof fetch;
      const client = createGitHubCommandClient({
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_TOKEN: "token",
      });

      await expect(
        client.getRepositoryPermission({
          repository: { slug: "local/pipr" },
          actor: "outsider",
        }),
      ).resolves.toBe("none");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("maps GitHub's non-collaborator permission payload to no repository permission", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () =>
        Response.json({ permission: "none", role_name: "" })) as unknown as typeof fetch;
      const client = createGitHubCommandClient({
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_TOKEN: "token",
      });

      await expect(
        client.getRepositoryPermission({
          repository: { slug: "local/pipr" },
          actor: "outsider",
        }),
      ).resolves.toBe("none");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("concatenates paginated review threads", async () => {
    const afters: Array<string | null> = [];
    await withGraphqlPages(
      afters,
      (after) =>
        after === null
          ? reviewThreadsPage([{ id: "thread-1", commentId: 1 }], {
              hasNextPage: true,
              endCursor: "c1",
            })
          : reviewThreadsPage([{ id: "thread-2", commentId: 2 }], {
              hasNextPage: false,
              endCursor: null,
            }),
      async (client) => {
        await expect(
          client.listReviewThreads({ repo: "local/pipr", pullRequestNumber: 7 }),
        ).resolves.toEqual([
          { id: "thread-1", isResolved: false, viewerCanResolve: true, commentIds: [1] },
          { id: "thread-2", isResolved: false, viewerCanResolve: true, commentIds: [2] },
        ]);
      },
    );
    expect(afters).toEqual([null, "c1"]);
  });

  it("rejects review thread pages that claim more pages without a cursor", async () => {
    const afters: Array<string | null> = [];
    await withGraphqlPages(
      afters,
      () =>
        reviewThreadsPage([{ id: "thread-1", commentId: 1 }], {
          hasNextPage: true,
          endCursor: null,
        }),
      async (client) => {
        await expect(
          client.listReviewThreads({ repo: "local/pipr", pullRequestNumber: 7 }),
        ).rejects.toThrow("without an end cursor");
      },
    );
    expect(afters).toEqual([null]);
  });

  it("bounds review thread pagination when GitHub never returns a terminal page", async () => {
    const afters: Array<string | null> = [];
    await withGraphqlPages(
      afters,
      (_after, call) =>
        reviewThreadsPage([{ id: `thread-${call}`, commentId: call }], {
          hasNextPage: true,
          endCursor: `c${call}`,
        }),
      async (client) => {
        await expect(
          client.listReviewThreads({ repo: "local/pipr", pullRequestNumber: 7 }),
        ).rejects.toThrow("exceeded 100 pages");
      },
    );
    expect(afters).toHaveLength(100);
  });
});

async function withGraphqlPages(
  afters: Array<string | null>,
  page: (after: string | null, call: number) => unknown,
  run: (client: ReturnType<typeof createGitHubPublicationClient>) => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { variables: { after: string | null } };
      afters.push(body.variables.after);
      if (afters.length > 200) throw new Error("fixture exhausted");
      return Response.json({ data: page(body.variables.after, afters.length) });
    }) as unknown as typeof fetch;
    await run(
      createGitHubPublicationClient({
        GITHUB_API_URL: "https://api.github.test",
        GITHUB_TOKEN: "token",
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function reviewThreadsPage(
  threads: Array<{ id: string; commentId: number }>,
  pageInfo: { hasNextPage: boolean; endCursor: string | null },
) {
  return {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo,
          nodes: threads.map((thread) => ({
            id: thread.id,
            isResolved: false,
            viewerCanResolve: true,
            comments: { nodes: [{ databaseId: thread.commentId }] },
          })),
        },
      },
    },
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}
