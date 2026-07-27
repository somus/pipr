import { describe, expect, it } from "bun:test";
import { buildPublicationPlan, type InlinePublicationItem } from "../../../review/comment.js";
import { buildPriorReviewState, renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { createGiteaHostAdapter } from "../adapter.js";
import type { GiteaClient, GiteaComment, GiteaPullRequest, GiteaReviewComment } from "../client.js";

describe("Gitea-compatible host adapter", () => {
  it("creates and then updates one owned main review comment", async () => {
    const client = new FakeGiteaClient();
    const adapter = createGiteaHostAdapter({ host: "forgejo", client });

    const first = await adapter.publication?.publish({ change, plan: publicationPlan() });
    const second = await adapter.publication?.publish({ change, plan: publicationPlan() });

    expect(first?.mainComment.action).toBe("created");
    expect(second?.mainComment.action).toBe("updated");
    expect(client.issueComments).toHaveLength(1);
    expect(client.issueComments[0]?.body).toContain("Summary.");
  });

  it("publishes each inline finding once at a native single-line position", async () => {
    const client = new FakeGiteaClient();
    const adapter = createGiteaHostAdapter({ host: "forgejo", client });
    const plan = publicationPlan(true);

    const first = await adapter.publication?.publish({ change, plan });
    const second = await adapter.publication?.publish({ change, plan });

    expect(first?.inlineComments).toEqual({ posted: 1, skipped: 0, failed: 0 });
    expect(second?.inlineComments).toEqual({ posted: 0, skipped: 1, failed: 0 });
    expect(client.reviewWrites).toEqual([
      {
        body: expect.stringContaining("Fix this."),
        path: "src/a.ts",
        commitId: "head",
        line: 4,
        side: "RIGHT",
      },
    ]);
  });

  it("creates and updates one response for a command comment", async () => {
    const client = new FakeGiteaClient();
    const adapter = createGiteaHostAdapter({ host: "forgejo", client });

    await expect(
      adapter.publication?.publishCommandResponse?.({
        change,
        sourceCommentId: "42",
        commandName: "review",
        body: "First.",
      }),
    ).resolves.toMatchObject({ action: "created" });
    await expect(
      adapter.publication?.publishCommandResponse?.({
        change,
        sourceCommentId: "42",
        commandName: "review",
        body: "Updated.",
      }),
    ).resolves.toMatchObject({ action: "updated" });
    expect(client.issueComments).toHaveLength(1);
    expect(client.issueComments[0]?.body).toContain("Updated.");
  });

  it("reconstructs prior review state from owned main and inline comments", async () => {
    const client = new FakeGiteaClient();
    const adapter = createGiteaHostAdapter({ host: "forgejo", client });

    await adapter.publication?.publish({ change, plan: publicationPlan(true) });

    await expect(adapter.comments?.loadPriorReviewState?.({ change })).resolves.toMatchObject({
      reviewedHeadSha: "head",
      findings: [{ path: "src/a.ts", status: "open" }],
    });
    await expect(adapter.comments?.loadPriorMainComment?.({ change })).resolves.toContain(
      "Summary.",
    );
  });

  it("does not publish a final review after progress ownership changes", async () => {
    const client = new FakeGiteaClient();
    const adapter = createGiteaHostAdapter({ host: "forgejo", client });
    const publishProgress = adapter.publication?.publishReviewProgress;
    if (!publishProgress) throw new Error("Expected progress publication");
    const first = await publishProgress({
      change,
      reviewedHeadSha: "head",
      renderBody: () => progressBody("11111111-1111-4111-8111-111111111111"),
    });
    if (first.status !== "published") throw new Error("Expected published progress");
    await publishProgress({
      change,
      reviewedHeadSha: "head",
      renderBody: () => progressBody("22222222-2222-4222-8222-222222222222"),
    });

    await expect(
      adapter.publication?.publish({
        change,
        plan: publicationPlan(true),
        progressLease: {
          token: "11111111-1111-4111-8111-111111111111",
          mainCommentId: first.id,
          mainCommentAction: first.action,
          reviewedHeadSha: "head",
        },
      }),
    ).rejects.toThrow("superseded");
    expect(client.reviewWrites).toEqual([]);
  });
});

const change: ChangeRequestEventContext = {
  eventName: "pull_request",
  action: "synchronized",
  platform: { id: "forgejo", host: "https://forge.example.com" },
  repository: { slug: "acme/pipr", url: "https://forge.example.com/acme/pipr" },
  coordinates: { provider: "gitea", owner: "acme", repository: "pipr" },
  change: {
    number: 7,
    title: "Test PR",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
  workspace: "/workspace",
};

function publicationPlan(withInline = false) {
  const finding = {
    body: "Fix this.",
    path: "src/a.ts",
    rangeId: "range-1",
    side: "RIGHT" as const,
    startLine: 3,
    endLine: 4,
  };
  const inlineItem: InlinePublicationItem = {
    finding,
    range: {
      id: "range-1",
      path: "src/a.ts",
      side: "RIGHT",
      startLine: 3,
      endLine: 4,
      kind: "added",
      hunkIndex: 1,
      hunkHeader: "@@ -1 +1,4 @@",
      hunkContentHash: "deadbeefcafe",
    },
    path: "src/a.ts",
    side: "RIGHT",
    startLine: 3,
    endLine: 4,
    body: `${renderInlineFindingMarker("finding-1", "head")}\nFix this.`,
    marker: "pipr:finding:finding-1:head",
    findingId: "finding-1",
    reviewedHeadSha: "head",
  };
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems: withInline ? [inlineItem] : [],
    reviewState: buildPriorReviewState({
      findings: withInline ? [{ finding }] : [],
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
    }),
    metadata: {
      runtimeVersion: "0.6.3",
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: withInline ? 1 : 0,
      droppedFindings: 0,
    },
  });
}

function progressBody(token: string): string {
  return [
    "<!-- pipr:main-comment change=7 version=1 -->",
    `<!-- pipr:progress:start token=${token} head=head stage=preparing-workspace state=running -->`,
    "## Progress",
    "<!-- pipr:progress:end -->",
  ].join("\n");
}

class FakeGiteaClient implements GiteaClient {
  host = "forgejo" as const;
  issueComments: GiteaComment[] = [];
  reviewComments: GiteaReviewComment[] = [];
  reviewWrites: Array<{
    body: string;
    path: string;
    commitId: string;
    line: number;
    side: "RIGHT" | "LEFT";
  }> = [];
  pullRequest: GiteaPullRequest = {
    number: 7,
    title: "Test PR",
    body: "",
    html_url: "https://forge.example.com/acme/pipr/pulls/7",
    base: {
      ref: "main",
      sha: "base",
      repo: { id: 1, full_name: "acme/pipr", html_url: "https://forge.example.com/acme/pipr" },
    },
    head: {
      ref: "feature",
      sha: "head",
      repo: { id: 1, full_name: "acme/pipr", html_url: "https://forge.example.com/acme/pipr" },
    },
  };
  currentUser = async () => ({ id: 1, login: "pipr-bot" });
  getRepository = async () => this.pullRequest.base.repo;
  getPullRequest = async () => this.pullRequest;
  loadChange = async () => ({
    repository: change.repository,
    coordinates: { provider: "gitea" as const, owner: "acme", repository: "pipr" },
    change: change.change,
  });
  getRepositoryPermission = async () => "write" as const;
  listIssueComments = async () => this.issueComments;
  createIssueComment = async (
    _owner: string,
    _repository: string,
    _changeNumber: number,
    body: string,
  ) => {
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
    comment.body = body;
    return comment;
  };
  listReviewComments = async () => this.reviewComments;
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
    this.reviewWrites.push(comment);
    this.reviewComments.push({
      id: String(this.reviewComments.length + 1),
      body: comment.body,
      authorLogin: "pipr-bot",
      path: comment.path,
      commitId: comment.commitId,
      line: comment.line,
      side: comment.side,
    });
    return `review-${this.reviewComments.length}`;
  };
  replyToReviewComment = async (
    _owner: string,
    _repository: string,
    _changeNumber: number,
    commentId: string,
    body: string,
  ) => {
    const comment = {
      id: String(this.reviewComments.length + 1),
      parentId: commentId,
      body,
      authorLogin: "pipr-bot",
    };
    this.reviewComments.push(comment);
    return comment.id;
  };
  setStatus = async () => "status-1";
}
