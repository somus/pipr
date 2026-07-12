import { describe, expect, it } from "bun:test";
import { buildPublicationPlan, type InlinePublicationItem } from "../../../review/comment.js";
import { buildPriorReviewState, renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { createGitLabHostAdapter } from "../adapter.js";
import type {
  GitLabClient,
  GitLabDiscussion,
  GitLabMergeRequest,
  GitLabNote,
  GitLabPosition,
} from "../client.js";

describe("GitLab host adapter", () => {
  it("publishes idempotent main, inline, and status results through GitLab", async () => {
    const client = new FakeGitLabClient();
    const adapter = createGitLabHostAdapter({ client });
    const plan = publicationPlan();

    const first = await adapter.publication?.publish({ change, plan });
    const second = await adapter.publication?.publish({ change, plan });
    const status = await adapter.statuses?.upsert({
      change,
      name: "review",
      state: "success",
      summary: "Done.",
    });

    expect(first).toMatchObject({
      mainComment: { action: "created" },
      inlineComments: { posted: 1, skipped: 0, failed: 0 },
    });
    expect(second).toMatchObject({
      mainComment: { action: "updated" },
      inlineComments: { posted: 0, skipped: 1, failed: 0 },
    });
    expect(client.positions[0]).toMatchObject({
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      new_path: "src/a.ts",
      new_line: 2,
    });
    expect(status).toEqual({ id: "status-1", name: "review" });
  });

  it("fails stale publication before any GitLab write", async () => {
    const client = new FakeGitLabClient();
    client.mergeRequest = {
      ...client.mergeRequest,
      diff_refs: { ...client.mergeRequest.diff_refs, head_sha: "new-head" },
    };
    const adapter = createGitLabHostAdapter({ client });

    await expect(adapter.publication?.publish({ change, plan: publicationPlan() })).rejects.toThrow(
      "head changed",
    );
    expect(client.notes).toEqual([]);
    expect(client.discussions).toEqual([]);
  });

  it("loads prior state and inline discussion contexts", async () => {
    const client = new FakeGitLabClient();
    const adapter = createGitLabHostAdapter({ client });
    await adapter.publication?.publish({ change, plan: publicationPlan() });

    await expect(adapter.comments?.loadPriorReviewState?.({ change })).resolves.toMatchObject({
      reviewedHeadSha: "head",
    });
    await expect(adapter.comments?.loadInlineThreadContexts?.({ change })).resolves.toMatchObject([
      { findingId: "finding-1", findingHeadSha: "head", threadResolved: false },
    ]);
  });
});

const change: ChangeRequestEventContext = {
  eventName: "merge_request",
  action: "updated",
  platform: { id: "gitlab", host: "https://gitlab.com" },
  repository: { slug: "group/project" },
  coordinates: { provider: "gitlab", projectId: "42", projectPath: "group/project" },
  change: {
    number: 7,
    title: "Test MR",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
  workspace: "/workspace",
};

function publicationPlan() {
  const finding = {
    body: "Fix this.",
    path: "src/a.ts",
    rangeId: "range-1",
    side: "RIGHT" as const,
    startLine: 2,
    endLine: 2,
  };
  const inlineItem: InlinePublicationItem = {
    finding,
    range: {
      id: "range-1",
      path: "src/a.ts",
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
      kind: "added",
      hunkIndex: 1,
      hunkHeader: "@@ -1 +1,2 @@",
      hunkContentHash: "deadbeefcafe",
    },
    path: "src/a.ts",
    side: "RIGHT",
    startLine: 2,
    endLine: 2,
    body: `${renderInlineFindingMarker("finding-1", "head")}\nFix this.`,
    marker: "pipr:finding:finding-1:head",
    findingId: "finding-1",
    reviewedHeadSha: "head",
  };
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems: [inlineItem],
    reviewState: buildPriorReviewState({
      findings: [finding],
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

class FakeGitLabClient implements GitLabClient {
  notes: GitLabNote[] = [];
  discussions: GitLabDiscussion[] = [];
  positions: GitLabPosition[] = [];
  mergeRequest: GitLabMergeRequest = {
    iid: 7,
    title: "Test MR",
    description: "",
    source_branch: "feature",
    target_branch: "main",
    source_project_id: 42,
    target_project_id: 42,
    sha: "head",
    diff_refs: { base_sha: "base", start_sha: "start", head_sha: "head" },
  };
  currentUser = async () => ({ id: 1, username: "pipr-bot" });
  loadChange = async () => ({
    repository: { slug: "group/project" },
    coordinates: { provider: "gitlab" as const, projectId: "42", projectPath: "group/project" },
    change: change.change,
  });
  getMergeRequest = async () => this.mergeRequest;
  getRepositoryPermission = async () => "write" as const;
  listNotes = async () => this.notes;
  createNote = async (_projectId: string, _changeNumber: number, body: string) => {
    const note = {
      id: String(this.notes.length + 1),
      body,
      author: { id: 1, username: "pipr-bot" },
    };
    this.notes.push(note);
    return note;
  };
  updateNote = async (_projectId: string, _changeNumber: number, noteId: string, body: string) => {
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`Unknown note ${noteId}`);
    note.body = body;
    return note;
  };
  listDiscussions = async () => this.discussions;
  findReplyParent = async (
    _projectId: string,
    _changeNumber: number,
    noteId: string,
    discussionId?: string,
  ) => {
    const discussion = this.discussions.find(
      (candidate) =>
        (!discussionId || candidate.id === discussionId) &&
        candidate.notes.some((note) => note.id === noteId),
    );
    return discussion && discussion.notes[0]?.id !== noteId ? discussion.id : undefined;
  };
  createDiscussion = async (
    _projectId: string,
    _changeNumber: number,
    body: string,
    position: GitLabPosition,
  ) => {
    const discussion = {
      id: `discussion-${this.discussions.length + 1}`,
      notes: [
        {
          id: `inline-${this.discussions.length + 1}`,
          body,
          author: { id: 1, username: "pipr-bot" },
          resolved: false,
        },
      ],
    };
    this.positions.push(position);
    this.discussions.push(discussion);
    return discussion;
  };
  replyDiscussion = async (
    _projectId: string,
    _changeNumber: number,
    discussionId: string,
    body: string,
  ) => {
    const discussion = this.discussions.find((candidate) => candidate.id === discussionId);
    if (!discussion) throw new Error(`Unknown discussion ${discussionId}`);
    const note = {
      id: `reply-${discussion.notes.length}`,
      body,
      author: { id: 1, username: "pipr-bot" },
    };
    discussion.notes.push(note);
    return note;
  };
  resolveDiscussion = async (_projectId: string, _changeNumber: number, discussionId: string) => {
    const root = this.discussions.find((candidate) => candidate.id === discussionId)?.notes[0];
    if (root) root.resolved = true;
  };
  setStatus = async () => "status-1";
}
