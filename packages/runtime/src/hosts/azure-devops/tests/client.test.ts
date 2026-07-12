import { describe, expect, it } from "bun:test";
import { azureRepositoryPermission, createAzureDevOpsClient } from "../client.js";

describe("Azure DevOps API client", () => {
  it.each([
    ["SYSTEM_ACCESSTOKEN", "pipeline-token"],
    ["AZURE_DEVOPS_BEARER_TOKEN", "entra-token"],
  ] as const)("uses Bearer authentication for %s", async (variable, token) => {
    const authorizations: Array<string | null> = [];
    const client = createAzureDevOpsClient(
      {
        AZURE_DEVOPS_ORGANIZATION: "org",
        AZURE_DEVOPS_PROJECT: "project",
        [variable]: token,
      },
      async (_input, init) => {
        authorizations.push(new Headers(init?.headers).get("Authorization"));
        return Response.json({ authenticatedUser: {} });
      },
    );

    await client.currentUser();
    expect(authorizations).toEqual([`Bearer ${token}`]);
  });

  it("uses Basic authentication for PATs", async () => {
    const authorizations: Array<string | null> = [];
    const client = createAzureDevOpsClient(azureEnv, async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("Authorization"));
      return Response.json({ authenticatedUser: {} });
    });

    await client.currentUser();
    expect(authorizations).toEqual([`Basic ${Buffer.from(":test-token").toString("base64")}`]);
  });

  it("loads a pull request and selects the iteration for the reviewed head", async () => {
    const requests: string[] = [];
    const client = createAzureDevOpsClient(azureEnv, async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("/iterations?")) {
        return Response.json({
          count: 2,
          value: [
            { id: 1, sourceRefCommit: { commitId: "old-head" } },
            { id: 2, sourceRefCommit: { commitId: "head" } },
          ],
        });
      }
      return Response.json(pullRequest);
    });

    await expect(
      client.loadChange({
        organization: "org",
        project: "project",
        repositoryId: "repo-id",
        changeNumber: 7,
      }),
    ).resolves.toMatchObject({
      repository: { slug: "org/project/repository" },
      coordinates: {
        provider: "azure-devops",
        organization: "org",
        project: "project",
        projectId: "project-id",
        repositoryId: "repo-id",
      },
      change: {
        number: 7,
        base: { sha: "target", ref: "main" },
        head: { sha: "head", ref: "feature" },
      },
      iterationId: 2,
    });
    expect(requests.every((url) => url.includes("api-version=7.1"))).toBe(true);
  });

  it("preserves the source repository for fork pull requests", async () => {
    const client = createAzureDevOpsClient(azureEnv, async (input) =>
      String(input).includes("/iterations?")
        ? Response.json({
            count: 1,
            value: [{ id: 2, sourceRefCommit: { commitId: "head" } }],
          })
        : Response.json({
            ...pullRequest,
            forkSource: {
              repository: { remoteUrl: "https://dev.azure.com/org/forks/_git/repository" },
            },
          }),
    );

    await expect(
      client.loadChange({
        organization: "org",
        project: "project",
        repositoryId: "repo-id",
        changeNumber: 7,
      }),
    ).resolves.toMatchObject({
      change: {
        isFork: true,
        head: { url: "https://dev.azure.com/org/forks/_git/repository" },
      },
    });
  });

  it("follows iteration change paging and preserves native tracking IDs", async () => {
    const requests: string[] = [];
    const client = createAzureDevOpsClient(azureEnv, async (input) => {
      const url = String(input);
      requests.push(url);
      return url.includes("$skip=1")
        ? Response.json({
            count: 1,
            value: [
              {
                changeTrackingId: 12,
                changeType: "rename",
                item: { path: "/src/new.ts", originalPath: "/src/old.ts" },
              },
            ],
          })
        : Response.json({
            count: 1,
            value: [{ changeTrackingId: 11, changeType: "edit", item: { path: "/src/a.ts" } }],
            nextSkip: 1,
            nextTop: 1,
          });
    });

    await expect(client.listIterationChanges("repo-id", 7, 2)).resolves.toEqual([
      { changeTrackingId: 11, changeType: "edit", path: "src/a.ts" },
      {
        changeTrackingId: 12,
        changeType: "rename",
        path: "src/new.ts",
        originalPath: "src/old.ts",
      },
    ]);
    expect(requests[0]).toContain("compareTo=0");
    expect(requests[1]).toContain("$skip=1");
  });

  it("uses Azure thread, comment, resolution, and PR status write contracts", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const responses = [
      { id: 10, comments: [{ id: 1, content: "root" }], status: "active" },
      { id: 1, content: "updated" },
      { id: 2, content: "reply" },
      { id: 10, comments: [], status: "fixed" },
      { id: 99 },
    ];
    const client = createAzureDevOpsClient(azureEnv, async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(responses.shift());
    });
    const thread = {
      comments: [{ parentCommentId: 0, content: "inline", commentType: 1 }],
      status: "active",
      threadContext: {
        filePath: "/src/a.ts",
        rightFileStart: { line: 2, offset: 1 },
        rightFileEnd: { line: 3, offset: 14 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 11,
        iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 },
      },
    };

    await client.createThread("repo-id", 7, thread);
    await client.updateComment("repo-id", 7, "10", "1", "updated");
    await client.createThreadComment("repo-id", 7, "10", {
      parentCommentId: 1,
      content: "reply",
      commentType: 1,
    });
    await client.updateThreadStatus("repo-id", 7, "10", "fixed");
    await client.createStatus("repo-id", 7, {
      state: "succeeded",
      description: "complete",
      context: { genre: "pipr", name: "pipr/review" },
      iterationId: 2,
    });

    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "POST /org/project/_apis/git/repositories/repo-id/pullRequests/7/threads",
      "PATCH /org/project/_apis/git/repositories/repo-id/pullRequests/7/threads/10/comments/1",
      "POST /org/project/_apis/git/repositories/repo-id/pullRequests/7/threads/10/comments",
      "PATCH /org/project/_apis/git/repositories/repo-id/pullRequests/7/threads/10",
      "POST /org/project/_apis/git/repositories/repo-id/pullRequests/7/statuses",
    ]);
    expect(requests[0]?.body).toEqual(thread);
    expect(requests[3]?.body).toEqual({ status: "fixed" });
  });

  it("evaluates effective user and inherited group permissions with deny precedence", async () => {
    const aclTokens: string[] = [];
    const client = createAzureDevOpsClient(azureEnv, async (input) => {
      const url = String(input);
      if (url.includes("/_apis/identities?")) {
        return Response.json({
          count: 1,
          value: [
            {
              descriptor: "user-descriptor",
              isActive: true,
              isContainer: false,
              memberOf: [{ descriptor: "contributors-group" }],
            },
          ],
        });
      }
      expect(url).toContain("descriptors=user-descriptor%2Ccontributors-group");
      const token = new URL(url).searchParams.get("token") ?? "";
      aclTokens.push(token);
      return Response.json({
        count: 1,
        value: [
          {
            inheritPermissions: true,
            acesDictionary: {
              user: {
                allow: token === "repoV2/project-id" ? 16387 : 0,
                deny: 0,
              },
              group: {
                allow: 0,
                deny: token.endsWith("/repo-id") ? 2 : 0,
              },
            },
          },
        ],
      });
    });

    await expect(
      client.getRepositoryPermission("developer@example.com", "project-id", "repo-id"),
    ).resolves.toBe("triage");
    expect(aclTokens).toEqual(["repoV2/project-id", "repoV2/project-id/repo-id"]);
    expect(azureRepositoryPermission(1 | 2 | 16384)).toBe("write");
    expect(azureRepositoryPermission(1 | 2048)).toBe("maintain");
    expect(azureRepositoryPermission(1 | 8192)).toBe("admin");
  });
});

const azureEnv = {
  AZURE_DEVOPS_TOKEN: "test-token",
  AZURE_DEVOPS_ORGANIZATION: "org",
  AZURE_DEVOPS_PROJECT: "project",
};

const pullRequest = {
  pullRequestId: 7,
  title: "Update fixture",
  description: "Body",
  url: "https://dev.azure.com/org/project/_git/repository/pullrequest/7",
  sourceRefName: "refs/heads/feature",
  targetRefName: "refs/heads/main",
  createdBy: { displayName: "Developer", uniqueName: "developer@example.com" },
  lastMergeSourceCommit: { commitId: "head" },
  lastMergeTargetCommit: { commitId: "target" },
  repository: {
    id: "repo-id",
    name: "repository",
    url: "https://dev.azure.com/org/project/_apis/git/repositories/repo-id",
    project: { id: "project-id", name: "project" },
  },
};
