import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeRequestEventContext } from "../../../types.js";
import {
  type CodeHostAdapterConformanceHarness,
  defineCodeHostAdapterConformanceSuite,
} from "../../tests/conformance.js";
import type { CodeHostStatusState, RepositoryPermission } from "../../types.js";
import { createGiteaHostAdapter } from "../adapter.js";
import type { GiteaClient, GiteaComment, GiteaPullRequest, GiteaReviewComment } from "../client.js";

defineCodeHostAdapterConformanceSuite({
  name: "Forgejo",
  capabilities: {
    commandComments: true,
    reviewCommentReplies: true,
    threadResolution: false,
    multilineInlineComments: false,
    suggestedChanges: false,
    statuses: true,
  },
  createHarness,
});

const change: ChangeRequestEventContext = {
  eventName: "pull_request",
  action: "opened",
  platform: { id: "forgejo", host: "https://forge.example.com" },
  repository: { slug: "acme/pipr", url: "https://forge.example.com/acme/pipr" },
  coordinates: { provider: "gitea", owner: "acme", repository: "pipr" },
  change: {
    number: 7,
    title: "Test PR",
    description: "",
    url: "https://forge.example.com/acme/pipr/pulls/7",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
  workspace: "/workspace",
};

class FakeClient implements GiteaClient {
  host = "forgejo" as const;
  issueComments: GiteaComment[] = [];
  reviewComments: GiteaReviewComment[] = [];
  permission: RepositoryPermission = "write";
  permissionActors: string[] = [];
  failInline = false;
  afterListIssueComments?: () => void;
  afterListReviewComments?: () => void;
  mainCreates = 0;
  mainUpdates = 0;
  commandCreates = 0;
  commandUpdates = 0;
  replyCreates = 0;
  statusWrites: Array<{
    name: string;
    state: CodeHostStatusState;
    summary?: string;
    headSha: string;
  }> = [];
  pullRequest: GiteaPullRequest = pullRequest("head");

  currentUser = async () => ({ id: 1, login: "pipr-bot" });
  getRepository = async () => this.pullRequest.base.repo;
  getPullRequest = async () => this.pullRequest;
  loadChange = async () => ({
    repository: change.repository,
    coordinates: { provider: "gitea" as const, owner: "acme", repository: "pipr" },
    change: change.change,
  });
  getRepositoryPermission = async (_owner: string, _repository: string, actor: string) => {
    this.permissionActors.push(actor);
    return this.permission;
  };
  listIssueComments = async () => {
    const comments = this.issueComments;
    this.afterListIssueComments?.();
    return comments;
  };
  createIssueComment = async (
    _owner: string,
    _repository: string,
    _changeNumber: number,
    body: string,
  ) => {
    if (body.includes("pipr:command-response")) this.commandCreates += 1;
    else this.mainCreates += 1;
    const comment = {
      id: String(this.issueComments.length + 1),
      body,
      authorLogin: "pipr-bot",
    };
    this.issueComments.push(comment);
    return comment;
  };
  updateIssueComment = async (
    _owner: string,
    _repository: string,
    commentId: string,
    body: string,
  ) => {
    const comment = this.issueComments.find((candidate) => candidate.id === commentId);
    if (!comment) throw new Error(`Unknown comment ${commentId}`);
    if (body.includes("pipr:command-response")) this.commandUpdates += 1;
    else this.mainUpdates += 1;
    comment.body = body;
    return comment;
  };
  listReviewComments = async () => {
    const comments = this.reviewComments;
    this.afterListReviewComments?.();
    return comments;
  };
  createReviewComment = async (
    _owner: string,
    _repository: string,
    _changeNumber: number,
    comment: {
      body: string;
      path: string;
      commitId: string;
      line: number;
      side: "RIGHT" | "LEFT";
    },
  ) => {
    if (this.failInline) {
      this.failInline = false;
      throw new Error("Forgejo rejected the inline comment");
    }
    const value: GiteaReviewComment = {
      id: String(this.reviewComments.length + 1),
      body: comment.body,
      authorLogin: "pipr-bot",
      path: comment.path,
      commitId: comment.commitId,
      line: comment.line,
      side: comment.side,
    };
    this.reviewComments.push(value);
    return value.id;
  };
  replyToReviewComment = async (
    _owner: string,
    _repository: string,
    _changeNumber: number,
    commentId: string,
    body: string,
  ) => {
    this.replyCreates += 1;
    const value: GiteaReviewComment = {
      id: String(this.reviewComments.length + 1),
      parentId: commentId,
      body,
      authorLogin: "pipr-bot",
    };
    this.reviewComments.push(value);
    return value.id;
  };
  setStatus = async (
    _owner: string,
    _repository: string,
    sha: string,
    name: string,
    state: CodeHostStatusState,
    description?: string,
  ) => {
    this.statusWrites.push({
      name,
      state,
      ...(description ? { summary: description } : {}),
      headSha: sha,
    });
    return `status-${name}`;
  };
}

async function createHarness(): Promise<CodeHostAdapterConformanceHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-forgejo-conformance-"));
  const client = new FakeClient();
  const adapter = createGiteaHostAdapter({ host: "forgejo", client });
  return {
    adapter,
    change,
    async events() {
      const eventPath = path.join(root, "event.json");
      const repository = {
        full_name: "acme/pipr",
        html_url: "https://forge.example.com/acme/pipr",
      };
      const sender = { login: "developer" };
      await Bun.write(
        eventPath,
        JSON.stringify({
          action: "open",
          number: 7,
          pull_request: { draft: false },
          repository,
          sender,
        }),
      );
      const changeRequest = await adapter.events.parseEvent({
        eventPath,
        env: { PIPR_GITEA_EVENT_NAME: "pull_request" },
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          action: "created",
          issue: { number: 7, pull_request: {} },
          comment: { id: 101, body: "@pipr review" },
          repository,
          sender,
        }),
      );
      const command = await adapter.events.parseEvent({
        eventPath,
        env: { PIPR_GITEA_EVENT_NAME: "issue_comment" },
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          action: "created",
          pull_request: { number: 7 },
          comment: { id: 102, in_reply_to_id: 101, body: "Fixed." },
          repository,
          sender,
        }),
      );
      const reply = await adapter.events.parseEvent({
        eventPath,
        env: { PIPR_GITEA_EVENT_NAME: "pull_request_review_comment" },
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          action: "open",
          number: 7,
          pull_request: { draft: true },
          repository,
          sender,
        }),
      );
      const draft = await adapter.events.parseEvent({
        eventPath,
        env: { PIPR_GITEA_EVENT_NAME: "pull_request" },
        workspace: root,
      });
      return { changeRequest, command, reply, draft };
    },
    setPermission(permission) {
      client.permission = permission;
    },
    permissionRequests: () => client.permissionActors.map((actor) => ({ actor })),
    setCurrentHead(headSha) {
      client.pullRequest = pullRequest(headSha);
    },
    advanceHeadDuringPreflight() {
      const advance = () => {
        client.afterListIssueComments = undefined;
        client.afterListReviewComments = undefined;
        client.pullRequest = pullRequest("new-head");
      };
      client.afterListIssueComments = advance;
      client.afterListReviewComments = advance;
    },
    supersedeProgressDuringPreflight(body) {
      client.afterListIssueComments = () => {
        client.afterListIssueComments = undefined;
        const main = client.issueComments.find((comment) =>
          comment.body.includes("pipr:main-comment"),
        );
        if (main) main.body = body;
      };
    },
    failNextInline() {
      client.failInline = true;
    },
    seedForeignInline() {
      client.reviewComments.push({
        id: "foreign-inline",
        body: "<!-- pipr:finding:foreign:head -->\nForeign.",
        authorLogin: "developer",
        path: "src/new.ts",
        commitId: "head",
        line: 2,
        side: "RIGHT",
      });
    },
    seedForeignReply(body) {
      const rootComment = client.reviewComments.find(
        (comment) => !comment.parentId && comment.authorLogin === "pipr-bot",
      );
      if (!rootComment) throw new Error("Forgejo conformance thread not found");
      client.reviewComments.push({
        id: "foreign-reply",
        parentId: rootComment.id,
        body,
        authorLogin: "developer",
      });
    },
    setFirstInlineResolved() {},
    ownedReplyBodies: () =>
      client.reviewComments
        .filter((comment) => comment.parentId && comment.authorLogin === "pipr-bot")
        .map((comment) => comment.body),
    writes: () => ({
      mainCreates: client.mainCreates,
      mainUpdates: client.mainUpdates,
      inlineCreates: client.reviewComments.filter(
        (comment) => !comment.parentId && comment.authorLogin === "pipr-bot",
      ).length,
      commandCreates: client.commandCreates,
      commandUpdates: client.commandUpdates,
      replies: client.replyCreates,
      resolutions: 0,
    }),
    anchors: () =>
      client.reviewComments
        .filter(
          (comment) =>
            !comment.parentId &&
            comment.authorLogin === "pipr-bot" &&
            comment.path &&
            comment.side &&
            comment.line !== undefined,
        )
        .map((comment) => ({
          path: comment.path ?? "",
          side: comment.side ?? "RIGHT",
          startLine: comment.line ?? 0,
          endLine: comment.line ?? 0,
          headSha: comment.commitId ?? "",
        })),
    statuses: () => client.statusWrites,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function pullRequest(headSha: string): GiteaPullRequest {
  const repository = {
    id: 1,
    full_name: "acme/pipr",
    html_url: "https://forge.example.com/acme/pipr",
  };
  return {
    number: 7,
    title: "Test PR",
    body: "",
    html_url: "https://forge.example.com/acme/pipr/pulls/7",
    base: { ref: "main", sha: "base", repo: repository },
    head: { ref: "feature", sha: headSha, repo: repository },
  };
}
