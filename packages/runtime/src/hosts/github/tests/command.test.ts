import { describe, expect, it } from "bun:test";
import { createGitHubCommandClient } from "../command.js";

describe("GitHub command client", () => {
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
});

function requestUrl(input: Parameters<typeof fetch>[0]): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}
