import { describe, expect, it } from "bun:test";
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
    expect(typeof adapter.events.parseEvent).toBe("function");
    expect(typeof adapter.events.loadChangeRequest).toBe("function");
    expect(typeof adapter.permissions.getRepositoryPermission).toBe("function");
    expect(typeof adapter.workspace.ensureHeadCheckout).toBe("function");
    expect(typeof adapter.publication?.publish).toBe("function");
    expect(typeof adapter.publication?.publishCommandResponse).toBe("function");
    expect(typeof adapter.comments?.loadPriorReviewState).toBe("function");
    expect(typeof adapter.checks?.createCheckRun).toBe("function");
    expect("parseEvent" in adapter).toBe(false);
    expect("publish" in adapter).toBe(false);
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
