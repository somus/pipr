import { afterEach, describe, expect, it } from "bun:test";
import { createGitHubPublicationClient } from "../../hosts/github/publication.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("createGitHubPublicationClient", () => {
  it("uses the GitHub Actions bot login without calling the user endpoint", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("fetch should not be called");
    }) as unknown as typeof fetch;

    const client = createGitHubPublicationClient({
      GITHUB_ACTIONS: "true",
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "actions-token",
    });

    await expect(client.getAuthenticatedUserLogin()).resolves.toBe("github-actions[bot]");
    expect(called).toBe(false);
  });

  it("lists all issue and review comment pages before marker checks", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url =
        typeof input === "string"
          ? input
          : input && typeof input === "object" && "url" in input
            ? String(input.url)
            : String(input);
      requestedUrls.push(url);
      const requestUrl = new URL(url);
      const page = requestUrl.searchParams.get("page") ?? "1";
      const headers =
        page === "1"
          ? {
              "Content-Type": "application/json",
              Link: `<${requestUrl.origin}${requestUrl.pathname}?per_page=100&page=2>; rel="next"`,
            }
          : { "Content-Type": "application/json" };
      const comments = [{ id: Number(page), body: `page ${page}` }];
      return new Response(JSON.stringify(comments), { status: 200, headers });
    }) as typeof fetch;

    const client = createGitHubPublicationClient({
      GITHUB_API_URL: "https://api.github.test",
    });

    await expect(
      client.listIssueComments({ repo: "local/pipr", issueNumber: 1 }),
    ).resolves.toHaveLength(2);
    await expect(
      client.listReviewComments({ repo: "local/pipr", pullRequestNumber: 1 }),
    ).resolves.toHaveLength(2);
    expect(requestedUrls).toHaveLength(4);
    expect(requestedUrls[0]).toContain("/repos/local/pipr/issues/1/comments");
    expect(requestedUrls[1]).toBe(
      "https://api.github.test/repos/local/pipr/issues/1/comments?per_page=100&page=2",
    );
    expect(requestedUrls[2]).toContain("/repos/local/pipr/pulls/1/comments");
    expect(requestedUrls[3]).toBe(
      "https://api.github.test/repos/local/pipr/pulls/1/comments?per_page=100&page=2",
    );
  });

  it("uses GitHub review reply and review thread APIs", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = mockGitHubReviewThreadApi(requests);

    const client = createGitHubPublicationClient({
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "actions-token",
    });

    await expect(
      client.createReviewCommentReply({
        repo: "local/pipr",
        pullRequestNumber: 1,
        commentId: 10,
        body: "Resolved.",
      }),
    ).resolves.toMatchObject({ id: 42, body: "resolved" });
    await expect(
      client.listReviewThreads({ repo: "local/pipr", pullRequestNumber: 1 }),
    ).resolves.toEqual([
      {
        id: "thread-1",
        isResolved: false,
        viewerCanResolve: true,
        commentIds: [10, 42],
      },
    ]);
    await expect(client.resolveReviewThread({ threadId: "thread-1" })).resolves.toBeUndefined();
    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.test/repos/local/pipr/pulls/1/comments/10/replies",
      "https://api.github.test/graphql",
      "https://api.github.test/graphql",
    ]);
  });

  it("creates and finalizes GitHub check runs", async () => {
    const requests: Array<{ url: string; body: string; method: string }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = {
        url: input instanceof Request ? input.url : String(input),
        body: await gitHubRequestBody(input, init),
        method: input instanceof Request ? input.method : (init?.method ?? "GET"),
      };
      requests.push(request);
      if (request.url.endsWith("/repos/local/pipr/check-runs") && request.method === "POST") {
        return jsonResponse({ id: 123, name: "pipr / review" });
      }
      if (request.url.endsWith("/repos/local/pipr/check-runs/123") && request.method === "PATCH") {
        return jsonResponse({ id: 123, name: "pipr / review" });
      }
      throw new Error(`unexpected request ${request.method} ${request.url}`);
    }) as typeof fetch;

    const client = createGitHubPublicationClient({
      GITHUB_API_URL: "https://api.github.test",
      GITHUB_TOKEN: "actions-token",
    });

    await expect(
      client.createCheckRun({
        repo: "local/pipr",
        name: "pipr / review",
        headSha: "head",
        summary: "Running.",
      }),
    ).resolves.toEqual({ id: 123, name: "pipr / review" });
    await client.updateCheckRun({
      repo: "local/pipr",
      checkRunId: 123,
      name: "pipr / review",
      conclusion: "failure",
      summary: "Failed.",
    });

    expect(requests.map((request) => request.url)).toEqual([
      "https://api.github.test/repos/local/pipr/check-runs",
      "https://api.github.test/repos/local/pipr/check-runs/123",
    ]);
    expect(JSON.parse(requests[0]?.body ?? "{}")).toMatchObject({
      name: "pipr / review",
      head_sha: "head",
      status: "in_progress",
      output: { title: "pipr / review", summary: "Running." },
    });
    expect(JSON.parse(requests[1]?.body ?? "{}")).toMatchObject({
      name: "pipr / review",
      conclusion: "failure",
      output: { title: "pipr / review", summary: "Failed." },
    });
    expect(JSON.parse(requests[1]?.body ?? "{}").completed_at).toEqual(expect.any(String));
  });
});

function mockGitHubReviewThreadApi(requests: Array<{ url: string; body: string }>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = {
      url: input instanceof Request ? input.url : String(input),
      body: await gitHubRequestBody(input, init),
    };
    requests.push(request);
    return gitHubReviewThreadApiResponse(request);
  }) as typeof fetch;
}

async function gitHubRequestBody(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<string> {
  if (input instanceof Request) {
    return input.clone().text();
  }
  return typeof init?.body === "string" ? init.body : "";
}

function gitHubReviewThreadApiResponse(request: { url: string; body: string }): Response {
  if (request.url.endsWith("/repos/local/pipr/pulls/1/comments/10/replies")) {
    return jsonResponse({ id: 42, body: "resolved" });
  }
  if (request.body.includes("PiprReviewThreads")) {
    return jsonResponse(reviewThreadsGraphqlResponse());
  }
  if (request.body.includes("PiprResolveReviewThread")) {
    return jsonResponse(resolveReviewThreadGraphqlResponse());
  }
  throw new Error(`unexpected request ${request.url}`);
}

function reviewThreadsGraphqlResponse() {
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                id: "thread-1",
                isResolved: false,
                viewerCanResolve: true,
                comments: {
                  nodes: [{ databaseId: 10 }, { databaseId: 42 }],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function resolveReviewThreadGraphqlResponse() {
  return {
    data: {
      resolveReviewThread: {
        thread: { id: "thread-1", isResolved: true },
      },
    },
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
