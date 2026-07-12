import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPublicationPlan, runtimeVersion } from "../../../review/comment.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { createGitHubHostAdapter } from "../adapter.js";
import type { GitHubCommandClient } from "../command.js";
import type { GitHubPublicationClient } from "../publication.js";

describe("GitHub host adapter contract", () => {
  it("normalizes native event fixtures through provider-neutral surfaces", async () => {
    await withEventFile("pull_request", pullRequestPayload(), async ({ eventPath, rootDir }) => {
      const adapter = createGitHubHostAdapter({
        env: githubEnv("pull_request", rootDir),
        commandClient: commandClient(),
        publicationClient: publicationClient(),
      });

      await expect(
        adapter.events.parseEvent({
          eventPath,
          env: githubEnv("pull_request", rootDir),
          workspace: rootDir,
        }),
      ).resolves.toMatchObject({
        kind: "change-request",
        change: {
          action: "opened",
          platform: { id: "github" },
          repository: { slug: "local/pipr" },
          change: { number: 7, base: { sha: "base" }, head: { sha: "head" } },
        },
      });
    });

    await withEventFile("issue_comment", issueCommentPayload(), async ({ eventPath, rootDir }) => {
      const adapter = createGitHubHostAdapter({
        env: githubEnv("issue_comment", rootDir),
        commandClient: commandClient(),
        publicationClient: publicationClient(),
      });

      await expect(
        adapter.events.parseEvent({
          eventPath,
          env: githubEnv("issue_comment", rootDir),
          workspace: rootDir,
        }),
      ).resolves.toMatchObject({
        kind: "command-comment",
        comment: {
          eventName: "issue_comment",
          changeNumber: 7,
          commentId: "123",
          isChangeRequest: true,
          body: "@pipr review",
          actor: "octo-dev",
        },
      });
    });

    await withEventFile(
      "pull_request_review_comment",
      reviewCommentPayload(),
      async ({ eventPath, rootDir }) => {
        const adapter = createGitHubHostAdapter({
          env: githubEnv("pull_request_review_comment", rootDir),
          commandClient: commandClient(),
          publicationClient: publicationClient(),
        });

        await expect(
          adapter.events.parseEvent({
            eventPath,
            env: githubEnv("pull_request_review_comment", rootDir),
            workspace: rootDir,
          }),
        ).resolves.toMatchObject({
          kind: "review-comment-reply",
          reply: {
            eventName: "pull_request_review_comment",
            changeNumber: 7,
            commentId: "456",
            parentCommentId: "123",
            body: "Still applies.",
            actor: "octo-dev",
          },
        });
      },
    );
  });

  it("routes command, permission, publication, comments, and checks through adapter clients", async () => {
    const calls: string[] = [];
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(calls),
      publicationClient: publicationClient(calls),
    });
    const loadedChange = await adapter.events.loadChangeRequest({
      repository: { slug: "fallback/repo" },
      changeNumber: 7,
      eventName: "pull_request",
      action: "opened",
      rawAction: "opened",
      workspace: "/workspace",
    });
    const change = changeEvent(loadedChange);

    await expect(
      adapter.permissions.getRepositoryPermission({
        repository: change.repository,
        actor: "octo-dev",
      }),
    ).resolves.toBe("maintain");
    await expect(adapter.comments?.loadPriorReviewState?.({ change })).resolves.toBeUndefined();
    await expect(adapter.comments?.loadPriorMainComment?.({ change })).resolves.toBeUndefined();
    await expect(adapter.comments?.loadInlineThreadContexts?.({ change })).resolves.toEqual([]);
    await expect(
      adapter.publication?.publishCommandResponse?.({
        change,
        sourceCommentId: "123",
        commandName: "review",
        body: "Queued.",
      }),
    ).resolves.toEqual({ action: "created", id: "1" });
    const checkRun = await adapter.statuses?.upsert({
      change,
      name: "pipr",
      state: "pending",
      summary: "Running.",
    });
    expect(checkRun).toEqual({ id: "9", name: "pipr" });
    await adapter.statuses?.upsert({
      change,
      name: "pipr",
      status: { id: "9", name: "pipr" },
      state: "success",
      summary: "Done.",
    });

    expect(calls).toContain("getPullRequest");
    expect(calls).toContain("getRepositoryPermission");
    expect(calls).toContain("listReviewComments");
    expect(calls).toContain("listReviewThreads");
    expect(calls).toContain("getPullRequestHeadSha");
    expect(calls).toContain("createIssueComment");
    expect(calls).toContain("createCheckRun");
    expect(calls).toContain("updateCheckRun");
  });

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

async function withEventFile(
  name: string,
  payload: unknown,
  run: (options: { eventPath: string; rootDir: string }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `pipr-${name}-`));
  try {
    const eventPath = path.join(rootDir, "event.json");
    await Bun.write(eventPath, JSON.stringify(payload));
    await run({ eventPath, rootDir });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
}

function githubEnv(eventName: string, rootDir: string): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_NAME: eventName,
    GITHUB_REPOSITORY: "local/pipr",
    GITHUB_WORKSPACE: rootDir,
  };
}

function pullRequestPayload() {
  return {
    action: "opened",
    number: 7,
    repository: { full_name: "local/pipr" },
    pull_request: {
      number: 7,
      title: "Adapter contract",
      body: "",
      user: { login: "octo-dev" },
      base: {
        sha: "base",
        ref: "main",
        repo: { full_name: "local/pipr" },
      },
      head: {
        sha: "head",
        ref: "feature",
        repo: { full_name: "local/pipr" },
        user: { login: "octo-dev" },
      },
    },
  };
}

function issueCommentPayload() {
  return {
    action: "created",
    repository: { full_name: "local/pipr" },
    issue: { number: 7, pull_request: {} },
    comment: {
      id: 123,
      body: "@pipr review",
      user: { login: "octo-dev" },
    },
  };
}

function reviewCommentPayload() {
  return {
    action: "created",
    repository: { full_name: "local/pipr" },
    pull_request: { number: 7 },
    comment: {
      id: 456,
      in_reply_to_id: 123,
      body: "Still applies.",
      user: { login: "octo-dev" },
    },
  };
}
