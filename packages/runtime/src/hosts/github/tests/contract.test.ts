import { describe, expect, it } from "bun:test";
import { buildPublicationPlan } from "../../../review/comment.js";
import { runtimeVersion } from "../../../shared/version.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { createGitHubHostAdapter } from "../adapter.js";
import type { GitHubCommandClient, GitHubPublicationClient } from "../client.js";

describe("GitHub host adapter contract", () => {
  it("prevents stale publication through the contract publication surface", async () => {
    const calls: string[] = [];
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: publicationClient(calls, { headSha: "new-head" }),
    });
    const loadedChange = await adapter.events.loadChangeRequest({
      repository: { slug: "local/pipr" },
      changeNumber: 7,
    });
    const change = changeEvent(loadedChange);

    await expect(
      adapter.publication?.publish({
        change,
        plan: buildPublicationPlan({
          event: change,
          main: "No findings.",
          inlineItems: [],
          metadata: {
            runtimeVersion,
            reviewedHeadSha: "head",
            selectedTasks: ["review"],
            failedTasks: [],
            validFindings: 0,
            droppedFindings: 0,
          },
        }),
      }),
    ).rejects.toThrow("Change request head changed");
    expect(calls).toEqual(["getPullRequestHeadSha"]);
  });

  it("loads no review comments or threads for prior state before a main comment exists", async () => {
    const calls: string[] = [];
    const client = publicationClient(calls);
    client.listReviewThreads = async () => {
      throw new Error("review threads should not be loaded");
    };
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: client,
    });
    const change = changeEvent(
      await commandClient().getPullRequest({
        repository: { slug: "local/pipr" },
        changeNumber: 7,
      }),
    );

    await expect(adapter.comments?.loadPriorReviewState?.({ change })).resolves.toBeUndefined();
    expect(calls).not.toContain("listReviewComments");
    expect(calls).not.toContain("listReviewThreads");
  });

  it("publishes a summary without loading review comments or threads", async () => {
    const calls: string[] = [];
    const client = publicationClient(calls);
    client.listReviewThreads = async () => {
      throw new Error("review threads should not be loaded");
    };
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: client,
    });
    const change = changeEvent(
      await commandClient().getPullRequest({
        repository: { slug: "local/pipr" },
        changeNumber: 7,
      }),
    );

    await expect(
      adapter.publication?.publish({
        change,
        plan: buildPublicationPlan({
          event: change,
          main: "No findings.",
          inlineItems: [],
          metadata: {
            runtimeVersion,
            reviewedHeadSha: "head",
            selectedTasks: ["review"],
            failedTasks: [],
            validFindings: 0,
            droppedFindings: 0,
          },
        }),
      }),
    ).resolves.toMatchObject({ mainComment: { action: "created" } });
    expect(calls).toContain("listIssueComments");
    expect(calls).not.toContain("listReviewComments");
    expect(calls).not.toContain("listReviewThreads");
  });

  it("publishes progress without loading review comments or threads", async () => {
    const calls: string[] = [];
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: publicationClient(calls),
    });
    const change = changeEvent(
      await commandClient().getPullRequest({
        repository: { slug: "local/pipr" },
        changeNumber: 7,
      }),
    );

    await expect(
      adapter.publication?.publishReviewProgress?.({
        change,
        reviewedHeadSha: "head",
        renderBody: () => "<!-- pipr:main-comment change=7 version=1 -->\nProgress.",
      }),
    ).resolves.toMatchObject({ status: "published", action: "created" });
    expect(calls).toContain("listIssueComments");
    expect(calls).not.toContain("listReviewComments");
    expect(calls).not.toContain("listReviewThreads");
  });

  it("publishes reply-only actions without loading GitHub review threads", async () => {
    const calls: string[] = [];
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: publicationClient(calls),
    });
    const change = changeEvent(
      await commandClient().getPullRequest({
        repository: { slug: "local/pipr" },
        changeNumber: 7,
      }),
    );

    await expect(
      adapter.publication?.publishThreadActions?.({
        change,
        reviewedHeadSha: "head",
        actions: [
          {
            kind: "reply",
            findingId: "finding-right",
            findingHeadSha: "head",
            commentId: "10",
            threadId: "thread-10",
            body: "Still applies.",
            responseKey: "reply:still-valid:finding-right",
          },
        ],
      }),
    ).resolves.toEqual({ errors: [] });
    expect(calls).toContain("listReviewComments");
    expect(calls).toContain("createReviewCommentReply");
    expect(calls).not.toContain("listReviewThreads");
  });
});

function commandClient(calls: string[] = []): GitHubCommandClient {
  return {
    async getPullRequest() {
      calls.push("getPullRequest");
      return {
        repository: { slug: "local/pipr", url: "https://github.test/local/pipr" },
        change: {
          number: 7,
          title: "Adapter contract",
          description: "",
          url: "https://github.test/local/pipr/pull/7",
          author: { login: "octo-dev" },
          base: { sha: "base", ref: "main", url: "https://github.test/local/pipr" },
          head: { sha: "head", ref: "feature", url: "https://github.test/local/pipr" },
          isFork: false,
        },
      };
    },
    async getRepositoryPermission() {
      calls.push("getRepositoryPermission");
      return "maintain";
    },
  };
}

function changeEvent(
  loaded: Awaited<ReturnType<GitHubCommandClient["getPullRequest"]>> & {
    eventName?: string;
    action?: string;
    rawAction?: string;
    workspace?: string;
  },
): ChangeRequestEventContext {
  return {
    ...loaded,
    eventName: loaded.eventName ?? "pull_request",
    platform: { id: "github" },
    workspace: loaded.workspace ?? "/workspace",
  };
}

function publicationClient(
  calls: string[] = [],
  options: { headSha?: string } = {},
): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      calls.push("getAuthenticatedUserLogin");
      return "github-actions[bot]";
    },
    async getPullRequestHeadSha() {
      calls.push("getPullRequestHeadSha");
      return options.headSha ?? "head";
    },
    async listIssueComments() {
      calls.push("listIssueComments");
      return [];
    },
    async createIssueComment() {
      calls.push("createIssueComment");
      return { id: 1 };
    },
    async updateIssueComment() {
      calls.push("updateIssueComment");
      return { id: 1 };
    },
    async listReviewComments() {
      calls.push("listReviewComments");
      return [];
    },
    async listReviewThreads() {
      calls.push("listReviewThreads");
      return [];
    },
    async createReviewComment() {
      calls.push("createReviewComment");
      return { id: 1 };
    },
    async createReviewCommentReply() {
      calls.push("createReviewCommentReply");
      return { id: 1 };
    },
    async resolveReviewThread() {
      calls.push("resolveReviewThread");
    },
    async createCheckRun() {
      calls.push("createCheckRun");
      return { id: 9, name: "pipr" };
    },
    async updateCheckRun() {
      calls.push("updateCheckRun");
    },
  };
}
