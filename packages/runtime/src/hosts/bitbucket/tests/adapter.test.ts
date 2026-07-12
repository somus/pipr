import { describe, expect, it } from "bun:test";
import { buildPublicationPlan, type InlinePublicationItem } from "../../../review/comment.js";
import { buildPriorReviewState, renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { createBitbucketHostAdapter } from "../adapter.js";
import type { BitbucketClient, BitbucketComment, BitbucketPullRequest } from "../client.js";

describe("Bitbucket Cloud adapter", () => {
  it("publishes idempotent main, multiline inline, commands, resolution, and statuses", async () => {
    const client = new FakeBitbucketClient();
    const adapter = createBitbucketHostAdapter({ client });
    const plan = publicationPlan();
    expect(await adapter.publication?.publish({ change, plan })).toMatchObject({
      mainComment: { action: "created" },
      inlineComments: { posted: 1 },
    });
    expect(await adapter.publication?.publish({ change, plan })).toMatchObject({
      mainComment: { action: "updated" },
      inlineComments: { skipped: 1 },
    });
    expect(client.createdBodies[1]).toMatchObject({
      inline: { path: "src/a.ts", to: 4, start_to: 2 },
    });
    const command = { change, sourceCommentId: "9", commandName: "ask", body: "answer" };
    await expect(adapter.publication?.publishCommandResponse?.(command)).resolves.toMatchObject({
      action: "created",
    });
    await expect(
      adapter.publication?.publishCommandResponse?.({ ...command, body: "updated" }),
    ).resolves.toMatchObject({ action: "updated" });
    const inline = client.comments.find((comment) => comment.inline);
    if (!inline) throw new Error("Expected inline comment");
    const action = {
      kind: "resolve" as const,
      findingId: "finding-1",
      findingHeadSha: "head",
      commentId: inline.id,
      threadId: inline.id,
      body: "resolved marker",
      responseKey: "resolved marker",
    };
    await adapter.publication?.publishThreadActions?.({
      change,
      actions: [action],
      reviewedHeadSha: "head",
    });
    await adapter.publication?.publishThreadActions?.({
      change,
      actions: [action],
      reviewedHeadSha: "head",
    });
    expect(client.comments.filter((comment) => comment.parent?.id === inline.id)).toHaveLength(1);
    expect(inline.resolved).toBe(true);
    await expect(
      adapter.statuses?.upsert({ change, name: "review", state: "success" }),
    ).resolves.toEqual({ id: "pipr-review", name: "review" });
    expect(client.statusBodies[0]).toMatchObject({ state: "SUCCESSFUL", refname: "feature" });
  });

  it("fails stale endpoints before writes and declares native limits", async () => {
    const client = new FakeBitbucketClient();
    client.pullRequest = {
      ...client.pullRequest,
      source: { ...client.pullRequest.source, commit: { hash: "new-head" } },
    };
    const adapter = createBitbucketHostAdapter({ client });
    await expect(adapter.publication?.publish({ change, plan: publicationPlan() })).rejects.toThrow(
      "endpoints changed",
    );
    expect(client.comments).toEqual([]);
    expect(adapter.capabilities).toEqual({
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: false,
      statuses: true,
    });
  });
});

const change: ChangeRequestEventContext = {
  eventName: "pullrequest:updated",
  platform: { id: "bitbucket" },
  repository: { slug: "workspace/repository" },
  coordinates: {
    provider: "bitbucket",
    workspace: "workspace",
    repository: "repository",
    repositoryUuid: "{repo}",
  },
  change: {
    number: 7,
    title: "PR",
    description: "",
    url: "https://bitbucket.org/workspace/repository/pull-requests/7",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
  workspace: "/workspace",
};

function publicationPlan() {
  const item: InlinePublicationItem = {
    finding: {
      body: "Fix",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 2,
      endLine: 4,
    },
    range: {
      id: "range-1",
      path: "src/a.ts",
      side: "RIGHT",
      startLine: 2,
      endLine: 4,
      kind: "added",
      hunkIndex: 1,
      hunkHeader: "@@ -1 +1,4 @@",
      hunkContentHash: "deadbeefcafe",
    },
    path: "src/a.ts",
    side: "RIGHT",
    startLine: 2,
    endLine: 4,
    findingId: "finding-1",
    reviewedHeadSha: "head",
    marker: "pipr:finding:finding-1:head",
    body: `${renderInlineFindingMarker("finding-1", "head")}\nFix`,
  };
  return buildPublicationPlan({
    event: change,
    main: "Summary",
    inlineItems: [item],
    reviewState: buildPriorReviewState({
      findings: [item.finding],
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
    }),
    metadata: {
      runtimeVersion: "0.4.0",
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: 1,
      droppedFindings: 0,
    },
  });
}

class FakeBitbucketClient implements BitbucketClient {
  workspace = "workspace";
  repository = "repository";
  comments: BitbucketComment[] = [];
  createdBodies: Array<Record<string, unknown>> = [];
  statusBodies: Array<Record<string, unknown>> = [];
  pullRequest: BitbucketPullRequest = {
    id: 7,
    title: "PR",
    description: "",
    source: endpoint("head", "feature"),
    destination: endpoint("base", "main"),
    links: { html: { href: "https://bitbucket.org/workspace/repository/pull-requests/7" } },
  };
  currentUser = async () => ({ uuid: "{bot}", nickname: "pipr" });
  getRepository = async () => ({
    uuid: "{repo}",
    slug: "repository",
    fullName: "workspace/repository",
    url: "https://bitbucket.org/workspace/repository",
  });
  getRepositoryPermission = async () => "write" as const;
  getPullRequest = async () => this.pullRequest;
  loadChange = async () => ({
    repository: change.repository,
    coordinates: change.coordinates as NonNullable<typeof change.coordinates>,
    change: change.change,
  });
  listComments = async () => this.comments;
  createComment = async (_id: number, body: Record<string, unknown>) => {
    this.createdBodies.push(body);
    const comment: BitbucketComment = {
      id: String(this.comments.length + 1),
      content: body.content as { raw: string },
      user: { uuid: "{bot}", nickname: "pipr" },
      inline: body.inline as BitbucketComment["inline"],
      parent: body.parent as BitbucketComment["parent"],
    };
    this.comments.push(comment);
    return comment;
  };
  updateComment = async (_id: number, commentId: string, content: string) => {
    const comment = this.comments.find((item) => item.id === commentId);
    if (!comment) throw new Error("missing");
    comment.content.raw = content;
    return comment;
  };
  replyToComment = async (id: number, commentId: string, content: string) =>
    this.createComment(id, { content: { raw: content }, parent: { id: commentId } });
  resolveComment = async (_id: number, commentId: string) => {
    const comment = this.comments.find((item) => item.id === commentId);
    if (comment) comment.resolved = true;
  };
  setStatus = async (_sha: string, key: string, body: Record<string, unknown>) => {
    this.statusBodies.push(body);
    return key;
  };
}

function endpoint(hash: string, branch: string) {
  return {
    branch: { name: branch },
    commit: { hash },
    repository: {
      uuid: "{repo}",
      name: "repository",
      slug: "repository",
      full_name: "workspace/repository",
      links: { html: { href: "https://bitbucket.org/workspace/repository" } },
    },
  };
}
