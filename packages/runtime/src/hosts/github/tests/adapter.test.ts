import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGitHubHostAdapter } from "../adapter.js";
import type { GitHubCommandClient } from "../command.js";
import type { GitHubPublicationClient } from "../publication.js";

describe("GitHub host adapter", () => {
  it("wires host capabilities into grouped adapter surfaces", () => {
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: publicationClient(),
    });

    expect(adapter.id).toBe("github");
    expect(adapter.capabilities).toEqual({
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: true,
      statuses: true,
    });
    expect(typeof adapter.events.parseEvent).toBe("function");
    expect(typeof adapter.events.loadChangeRequest).toBe("function");
    expect(typeof adapter.permissions.getRepositoryPermission).toBe("function");
    expect(typeof adapter.workspace.ensureHeadCheckout).toBe("function");
    expect(typeof adapter.publication?.publish).toBe("function");
    expect(typeof adapter.publication?.publishCommandResponse).toBe("function");
    expect(typeof adapter.comments?.loadPriorReviewState).toBe("function");
    expect(typeof adapter.statuses?.upsert).toBe("function");
    expect("parseEvent" in adapter).toBe(false);
    expect("publish" in adapter).toBe(false);
  });

  it("ignores draft pull request events", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-github-adapter-"));
    const eventPath = path.join(root, "event.json");
    await Bun.write(
      eventPath,
      JSON.stringify({
        action: "opened",
        number: 1,
        repository: { full_name: "local/pipr" },
        pull_request: {
          number: 1,
          draft: true,
          base: { sha: "base", repo: { full_name: "local/pipr" } },
          head: { sha: "head", repo: { full_name: "local/pipr" } },
        },
      }),
    );
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: publicationClient(),
    });
    try {
      await expect(
        adapter.events.parseEvent({
          eventPath,
          env: { GITHUB_EVENT_NAME: "pull_request", GITHUB_REPOSITORY: "local/pipr" },
          workspace: root,
        }),
      ).resolves.toEqual({ kind: "ignored", reason: "pull request is a draft" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function commandClient(): GitHubCommandClient {
  return {
    async getPullRequest() {
      return {
        repository: { slug: "local/pipr" },
        change: {
          number: 1,
          title: "Test change",
          description: "",
          base: { sha: "base" },
          head: { sha: "head" },
        },
      };
    },
    async getRepositoryPermission() {
      return "write";
    },
  };
}

function publicationClient(): GitHubPublicationClient {
  return {
    async getAuthenticatedUserLogin() {
      return "github-actions[bot]";
    },
    async getPullRequestHeadSha() {
      return "head";
    },
    async listIssueComments() {
      return [];
    },
    async createIssueComment() {
      return { id: 1 };
    },
    async updateIssueComment() {
      return { id: 1 };
    },
    async listReviewComments() {
      return [];
    },
    async listReviewThreads() {
      return [];
    },
    async createReviewComment() {
      return { id: 1 };
    },
    async createReviewCommentReply() {
      return { id: 1 };
    },
    async resolveReviewThread() {},
    async createCheckRun() {
      return { id: 1, name: "pipr" };
    },
    async updateCheckRun() {},
  };
}
