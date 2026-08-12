import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import {
  type CodeHostAdapterConformanceHarness,
  defineCodeHostAdapterConformanceSuite,
} from "../../tests/conformance.js";
import type { CodeHostStatusState, RepositoryPermission } from "../../types.js";
import { createGitHubHostAdapter } from "../adapter.js";
import type {
  GitHubCommandClient,
  GitHubIssueComment,
  GitHubPublicationClient,
  GitHubReviewComment,
  GitHubReviewThread,
} from "../client.js";

defineCodeHostAdapterConformanceSuite({
  name: "GitHub",
  capabilities: {
    commandComments: true,
    reviewCommentReplies: true,
    threadResolution: true,
    multilineInlineComments: true,
    suggestedChanges: true,
    statuses: true,
  },
  createHarness: createGitHubConformanceHarness,
});

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

class StatefulGitHubClient implements GitHubCommandClient, GitHubPublicationClient {
  issueComments: GitHubIssueComment[] = [];
  reviewComments: GitHubReviewComment[] = [];
  threads: GitHubReviewThread[] = [];
  currentHead = "head";
  permission: RepositoryPermission = "write";
  permissionActors: string[] = [];
  failInline = false;
  mainCreates = 0;
  mainUpdates = 0;
  commandCreates = 0;
  commandUpdates = 0;
  resolutionWrites = 0;
  statusWrites: Array<{
    name: string;
    state: CodeHostStatusState;
    summary?: string;
    headSha: string;
  }> = [];
  afterListIssueComments?: () => void;

  async getPullRequest() {
    return {
      repository: { slug: "local/pipr", url: "https://github.test/local/pipr" },
      change: {
        number: 7,
        title: "Adapter contract",
        description: "",
        url: "https://github.test/local/pipr/pull/7",
        author: { login: "developer" },
        base: { sha: "base", ref: "main", url: "https://github.test/local/pipr" },
        head: { sha: "head", ref: "feature", url: "https://github.test/local/pipr" },
        isFork: false,
      },
    };
  }

  async getRepositoryPermission(options: { actor: string }) {
    this.permissionActors.push(options.actor);
    return this.permission;
  }

  async getAuthenticatedUserLogin() {
    return "pipr-bot";
  }

  async getPullRequestHeadSha() {
    return this.currentHead;
  }

  async listIssueComments() {
    const comments = this.issueComments;
    this.afterListIssueComments?.();
    return comments;
  }

  async createIssueComment(options: { body: string }) {
    const comment = {
      id: this.issueComments.length + 1,
      body: options.body,
      authorLogin: "pipr-bot",
    };
    this.issueComments.push(comment);
    if (options.body.includes("pipr:command-response")) this.commandCreates += 1;
    else this.mainCreates += 1;
    return comment;
  }

  async updateIssueComment(options: { commentId: number; body: string }) {
    const comment = this.issueComments.find((item) => item.id === options.commentId);
    if (!comment) throw new Error("issue comment not found");
    comment.body = options.body;
    if (options.body.includes("pipr:command-response")) this.commandUpdates += 1;
    else this.mainUpdates += 1;
    return comment;
  }

  async listReviewComments() {
    const comments = this.reviewComments;
    this.afterListIssueComments?.();
    return comments;
  }

  async listReviewThreads() {
    return this.threads;
  }

  async createReviewComment(options: {
    body: string;
    path: string;
    commit_id: string;
    line: number;
    side: "RIGHT" | "LEFT";
    start_line?: number;
    start_side?: "RIGHT" | "LEFT";
  }) {
    if (this.failInline) {
      this.failInline = false;
      throw new Error("GitHub rejected the inline comment");
    }
    const id = this.reviewComments.length + 100;
    const comment: GitHubReviewComment = {
      id,
      body: options.body,
      authorLogin: "pipr-bot",
      path: options.path,
      commitId: options.commit_id,
      line: options.line,
      startLine: options.start_line,
      side: options.side,
      startSide: options.start_side,
    };
    this.reviewComments.push(comment);
    this.threads.push({
      id: `thread-${id}`,
      isResolved: false,
      viewerCanResolve: true,
      commentIds: [id],
    });
    return { id };
  }

  async createReviewCommentReply(options: { commentId: number; body: string }) {
    const id = this.reviewComments.length + 100;
    this.reviewComments.push({
      id,
      body: options.body,
      authorLogin: "pipr-bot",
      path: undefined,
      commitId: undefined,
      line: undefined,
      startLine: undefined,
      side: undefined,
      startSide: undefined,
    });
    const thread = this.threads.find((item) => item.commentIds.includes(options.commentId));
    if (thread) thread.commentIds.push(id);
    return { id };
  }

  async resolveReviewThread(options: { threadId: string }) {
    const thread = this.threads.find((item) => item.id === options.threadId);
    if (!thread) throw new Error("review thread not found");
    thread.isResolved = true;
    this.resolutionWrites += 1;
  }

  async createCheckRun(options: { name: string; headSha: string; summary?: string }) {
    this.statusWrites.push({
      name: options.name,
      state: "pending",
      summary: options.summary,
      headSha: options.headSha,
    });
    return { id: 9, name: options.name };
  }

  async updateCheckRun(options: {
    name: string;
    conclusion: "success" | "failure" | "neutral";
    summary?: string;
  }) {
    this.statusWrites.push({
      name: options.name,
      state: options.conclusion,
      summary: options.summary,
      headSha: "head",
    });
  }
}

async function createGitHubConformanceHarness(): Promise<CodeHostAdapterConformanceHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-github-conformance-"));
  const client = new StatefulGitHubClient();
  const adapter = createGitHubHostAdapter({
    env: {},
    commandClient: client,
    publicationClient: client,
  });
  const loaded = await adapter.events.loadChangeRequest({
    repository: { slug: "local/pipr" },
    changeNumber: 7,
    eventName: "pull_request",
    action: "updated",
    workspace: root,
  });
  const conformanceChange = changeEvent(loaded);
  return {
    adapter,
    change: conformanceChange,
    async events() {
      const eventPath = path.join(root, "event.json");
      await Bun.write(eventPath, JSON.stringify(pullRequestPayload()));
      const changeRequest = await adapter.events.parseEvent({
        eventPath,
        env: githubEnv("pull_request", root),
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          ...issueCommentPayload(),
          comment: { id: 101, body: "@pipr review", user: { login: "developer" } },
        }),
      );
      const command = await adapter.events.parseEvent({
        eventPath,
        env: githubEnv("issue_comment", root),
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          ...reviewCommentPayload(),
          comment: {
            id: 102,
            in_reply_to_id: 101,
            body: "Fixed.",
            user: { login: "developer" },
          },
        }),
      );
      const reply = await adapter.events.parseEvent({
        eventPath,
        env: githubEnv("pull_request_review_comment", root),
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          ...pullRequestPayload(),
          pull_request: { ...pullRequestPayload().pull_request, draft: true },
        }),
      );
      const draft = await adapter.events.parseEvent({
        eventPath,
        env: githubEnv("pull_request", root),
        workspace: root,
      });
      return { changeRequest, command, reply, draft };
    },
    setPermission(permission) {
      client.permission = permission;
    },
    permissionRequests: () => client.permissionActors.map((actor) => ({ actor })),
    setCurrentHead(headSha) {
      client.currentHead = headSha;
    },
    advanceHeadDuringPreflight() {
      client.afterListIssueComments = () => {
        client.afterListIssueComments = undefined;
        client.currentHead = "new-head";
      };
    },
    supersedeProgressDuringPreflight(body) {
      client.afterListIssueComments = () => {
        client.afterListIssueComments = undefined;
        client.issueComments = client.issueComments.map((comment) =>
          comment.body?.includes("pipr:main-comment") ? { ...comment, body } : comment,
        );
      };
    },
    failNextInline() {
      client.failInline = true;
    },
    seedForeignInline() {
      client.reviewComments.push({
        id: 900,
        body: `${renderInlineFindingMarker("foreign", "head")}\nForeign.`,
        authorLogin: "developer",
        path: "src/new.ts",
        commitId: "head",
        line: 4,
        startLine: 2,
        side: "RIGHT",
        startSide: "RIGHT",
      });
    },
    seedForeignReply(body) {
      const thread = client.threads.find((item) =>
        item.commentIds.some((id) =>
          client.reviewComments.some(
            (comment) => comment.id === id && comment.authorLogin === "pipr-bot" && comment.path,
          ),
        ),
      );
      if (!thread) throw new Error("GitHub conformance thread not found");
      const id = 901;
      client.reviewComments.push({
        id,
        body,
        authorLogin: "developer",
        path: undefined,
        commitId: undefined,
        line: undefined,
        startLine: undefined,
        side: undefined,
        startSide: undefined,
      });
      thread.commentIds.push(id);
    },
    setFirstInlineResolved(resolved) {
      const thread = client.threads.find((item) =>
        item.commentIds.some((id) =>
          client.reviewComments.some(
            (comment) => comment.id === id && comment.authorLogin === "pipr-bot" && comment.path,
          ),
        ),
      );
      if (!thread) throw new Error("GitHub conformance thread not found");
      thread.isResolved = resolved;
    },
    ownedReplyBodies: () =>
      client.reviewComments
        .filter((comment) => comment.authorLogin === "pipr-bot" && !comment.path)
        .map((comment) => comment.body ?? ""),
    writes: () => ({
      mainCreates: client.mainCreates,
      mainUpdates: client.mainUpdates,
      inlineCreates: client.reviewComments.filter(
        (comment) => comment.authorLogin === "pipr-bot" && comment.path,
      ).length,
      commandCreates: client.commandCreates,
      commandUpdates: client.commandUpdates,
      replies: client.reviewComments.filter(
        (comment) => comment.authorLogin === "pipr-bot" && !comment.path,
      ).length,
      resolutions: client.resolutionWrites,
    }),
    anchors: () =>
      client.reviewComments
        .filter((comment) => comment.path)
        .map((comment) => ({
          path: comment.path ?? "",
          ...(comment.side === "LEFT" ? { previousPath: "src/old.ts" } : {}),
          side: comment.side ?? "RIGHT",
          startLine: comment.startLine ?? comment.line ?? 0,
          endLine: comment.line ?? 0,
          headSha: comment.commitId ?? "",
        })),
    statuses: () => client.statusWrites,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
