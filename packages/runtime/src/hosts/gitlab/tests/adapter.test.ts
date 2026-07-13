import { describe, expect, it } from "bun:test";
import { buildPublicationPlan, type InlinePublicationItem } from "../../../review/comment.js";
import {
  buildPriorReviewState,
  renderInlineFindingMarker,
  renderVerifierResponseMarker,
} from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { runCodeHostAdapterContract } from "../../tests/adapter-contract.js";
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

  it("retries a transient main comment update", async () => {
    const client = new FakeGitLabClient();
    const publication = createGitLabHostAdapter({ client }).publication;
    await publication?.publish({ change, plan: publicationPlan() });
    client.loseNextNoteUpdate = true;

    await publication?.publish({ change, plan: publicationPlan() });

    expect(client.noteUpdateAttempts).toBe(2);
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

  it("rechecks the head after publication reads and before the first write", async () => {
    const client = new FakeGitLabClient();
    client.afterListNotes = () => {
      client.mergeRequest = {
        ...client.mergeRequest,
        diff_refs: { ...client.mergeRequest.diff_refs, head_sha: "new-head" },
      };
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

  it("exposes full capabilities and upserts command responses", async () => {
    const client = new FakeGitLabClient();
    const adapter = createGitLabHostAdapter({ client });
    expect(adapter.capabilities).toEqual({
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: true,
      statuses: true,
    });

    await expect(
      adapter.publication?.publishCommandResponse?.({
        change,
        sourceCommentId: "source-1",
        commandName: "review",
        body: "First.",
      }),
    ).resolves.toMatchObject({ action: "created" });
    await expect(
      adapter.publication?.publishCommandResponse?.({
        change,
        sourceCommentId: "source-1",
        commandName: "review",
        body: "Updated.",
      }),
    ).resolves.toMatchObject({ action: "updated" });
    expect(client.notes).toHaveLength(1);
    expect(client.notes[0]?.body).toContain("Updated.");
  });

  it("reports native inline failures without losing partial publication state", async () => {
    const client = new FakeGitLabClient();
    client.createDiscussionError = new Error("GitLab rejected the position");
    const adapter = createGitLabHostAdapter({ client });

    const error = await adapter.publication
      ?.publish({ change, plan: publicationPlan() })
      .catch((caught) => caught);
    expect(error).toMatchObject({
      message: "GitLab inline comment publication failed",
      result: { inlineComments: { posted: 0, skipped: 0, failed: 1 } },
    });
    expect(client.notes).toEqual([]);
  });

  it("renders native multiline anchors, renamed paths, suggestions, and thread actions", async () => {
    const client = new FakeGitLabClient();
    const adapter = createGitLabHostAdapter({ client });
    const baseItem = publicationPlan().inlineItems[0];
    if (!baseItem) throw new Error("Expected inline fixture");
    const plan = publicationPlan();
    plan.inlineItems = [
      {
        ...baseItem,
        path: "src/new.ts",
        previousPath: "src/old.ts",
        startLine: 3,
        endLine: 4,
        findingId: "finding-right",
        reviewedHeadSha: "head",
        body: `${renderInlineFindingMarker("finding-right", "head")}\nFix both.\n\n\`\`\`suggestion\nfirst replacement\n\`\`\`\n\n\`\`\`suggestion\r\nsecond replacement\r\n\`\`\``,
      },
      {
        ...baseItem,
        path: "src/new.ts",
        previousPath: "src/old.ts",
        side: "LEFT",
        startLine: 5,
        endLine: 6,
        findingId: "finding-left",
        reviewedHeadSha: "head",
        body: renderInlineFindingMarker("finding-left", "head"),
      },
    ];

    await adapter.publication?.publish({ change, plan });
    const newHash = new Bun.CryptoHasher("sha1").update("src/new.ts").digest("hex");
    const oldHash = new Bun.CryptoHasher("sha1").update("src/old.ts").digest("hex");
    expect(client.positions).toMatchObject([
      {
        old_path: "src/old.ts",
        new_path: "src/new.ts",
        new_line: 4,
        line_range: {
          start: { line_code: `${newHash}_0_3`, type: "new", new_line: 3 },
          end: { line_code: `${newHash}_0_4`, type: "new", new_line: 4 },
        },
      },
      {
        old_path: "src/old.ts",
        new_path: "src/new.ts",
        old_line: 6,
        line_range: {
          start: { line_code: `${oldHash}_5_0`, type: "old", old_line: 5 },
          end: { line_code: `${oldHash}_6_0`, type: "old", old_line: 6 },
        },
      },
    ]);
    expect(client.discussions[0]?.notes[0]?.body).toContain("```suggestion:-1+0");
    expect(client.discussions[0]?.notes[0]?.body.match(/```suggestion:-1\+0/g)).toHaveLength(2);

    await adapter.publication?.publishThreadActions?.({
      change,
      reviewedHeadSha: "head",
      actions: [
        {
          kind: "resolve",
          findingId: "finding-right",
          findingHeadSha: "head",
          commentId: "inline-1",
          threadId: "discussion-1",
          body: "Resolved.",
          responseKey: "head:fixed:finding-right",
        },
      ],
    });
    expect(client.discussions[0]?.notes).toHaveLength(2);
    expect(client.discussions[0]?.notes[0]?.resolved).toBe(true);
  });
});

runCodeHostAdapterContract("GitLab", {
  async staleHeadWrites() {
    const client = new FakeGitLabClient();
    client.mergeRequest.diff_refs.head_sha = "new-head";
    await createGitLabHostAdapter({ client })
      .publication?.publish({ change, plan: publicationPlan() })
      .catch(() => undefined);
    return client.notes.length + client.discussions.length;
  },
  async partialRetry() {
    const client = new FakeGitLabClient();
    client.loseNextDiscussionResponse = true;
    await createGitLabHostAdapter({ client }).publication?.publish({
      change,
      plan: publicationPlan(),
    });
    return { inlineWrites: client.discussions.length, mainWrites: client.notes.length };
  },
  async markerOwnership() {
    const client = new FakeGitLabClient();
    client.discussions.push(foreignGitLabDiscussion());
    const adapter = createGitLabHostAdapter({ client });
    await adapter.publication?.publish({ change, plan: publicationPlan() });
    const foreignWrites = client.discussions.filter(
      (discussion) => discussion.notes[0]?.author?.username === "someone-else",
    ).length;
    await adapter.publication?.publish({ change, plan: publicationPlan() });
    const ownedWritesAfterRerun = client.discussions.filter(
      (discussion) => discussion.notes[0]?.author?.username === "pipr-bot",
    ).length;
    return { foreignWrites, ownedWritesAfterRerun };
  },
  async statusIdempotency() {
    const client = new FakeGitLabClient();
    const statuses = createGitLabHostAdapter({ client }).statuses;
    const firstStatus = await statuses?.upsert({ change, name: "review", state: "pending" });
    const secondStatus = await statuses?.upsert({ change, name: "review", state: "success" });
    if (!firstStatus || !secondStatus) throw new Error("Expected status support");
    return {
      firstId: firstStatus.id,
      secondId: secondStatus.id,
      nativeRecords: client.statusKeys.size,
      statusWrites: client.statusWrites,
    };
  },
  async threadActions() {
    const client = new FakeGitLabClient();
    const publication = createGitLabHostAdapter({ client }).publication;
    await publication?.publish({ change, plan: publicationPlan() });
    const action = gitLabResolveAction();
    client.discussions[0]?.notes.push({
      id: "foreign-reply",
      body: renderVerifierResponseMarker(action.findingId, action.responseKey),
      author: { id: 2, username: "someone-else" },
    });
    client.loseNextReplyResponse = true;
    await publication?.publishThreadActions?.({
      change,
      reviewedHeadSha: "head",
      actions: [action],
    });
    await publication?.publishThreadActions?.({
      change,
      reviewedHeadSha: "head",
      actions: [action],
    });
    return {
      replies:
        client.discussions[0]?.notes.filter((note) => note.author?.username === "pipr-bot")
          .length === 2
          ? 1
          : 0,
      resolutions: client.resolveCalls,
    };
  },
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

function foreignGitLabDiscussion(): GitLabDiscussion {
  return {
    id: "foreign",
    notes: [
      {
        id: "foreign-inline",
        body: publicationPlan().inlineItems[0]?.body ?? "",
        author: { id: 2, username: "someone-else" },
        resolved: false,
      },
    ],
  };
}

function gitLabResolveAction() {
  return {
    kind: "resolve" as const,
    findingId: "finding-1",
    findingHeadSha: "head",
    commentId: "inline-1",
    threadId: "discussion-1",
    body: "Resolved.",
    responseKey: "response-key",
  };
}

class FakeGitLabClient implements GitLabClient {
  notes: GitLabNote[] = [];
  discussions: GitLabDiscussion[] = [];
  positions: GitLabPosition[] = [];
  createDiscussionError?: Error;
  loseNextDiscussionResponse = false;
  loseNextReplyResponse = false;
  loseNextNoteUpdate = false;
  noteUpdateAttempts = 0;
  statusKeys = new Set<string>();
  statusWrites = 0;
  resolveCalls = 0;
  afterListNotes?: () => void;
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
  getProject = async () => ({ id: "42", path: "group/project" });
  currentUser = async () => ({ id: 1, username: "pipr-bot" });
  loadChange = async () => ({
    repository: { slug: "group/project" },
    coordinates: { provider: "gitlab" as const, projectId: "42", projectPath: "group/project" },
    change: change.change,
  });
  getMergeRequest = async () => this.mergeRequest;
  getRepositoryPermission = async () => "write" as const;
  listNotes = async () => {
    const notes = this.notes;
    this.afterListNotes?.();
    return notes;
  };
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
    this.noteUpdateAttempts += 1;
    if (this.loseNextNoteUpdate) {
      this.loseNextNoteUpdate = false;
      throw Object.assign(new Error("unavailable"), { status: 503 });
    }
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`Unknown note ${noteId}`);
    note.body = body;
    return note;
  };
  listDiscussions = async () => this.discussions;
  getDiscussion = async (_projectId: string, _changeNumber: number, discussionId: string) => {
    const discussion = this.discussions.find((candidate) => candidate.id === discussionId);
    if (!discussion) throw new Error(`Unknown discussion ${discussionId}`);
    return discussion;
  };
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
    return discussion && discussion.notes[0]?.id !== noteId ? discussion.notes[0]?.id : undefined;
  };
  createDiscussion = async (
    _projectId: string,
    _changeNumber: number,
    body: string,
    position: GitLabPosition,
  ) => {
    if (this.createDiscussionError) throw this.createDiscussionError;
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
    if (this.loseNextDiscussionResponse) {
      this.loseNextDiscussionResponse = false;
      throw Object.assign(new Error("response lost"), { status: 503 });
    }
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
    if (this.loseNextReplyResponse) {
      this.loseNextReplyResponse = false;
      throw Object.assign(new Error("response lost"), { status: 503 });
    }
    return note;
  };
  resolveDiscussion = async (_projectId: string, _changeNumber: number, discussionId: string) => {
    this.resolveCalls += 1;
    const root = this.discussions.find((candidate) => candidate.id === discussionId)?.notes[0];
    if (root) root.resolved = true;
  };
  setStatus = async (_projectId: string, sha: string, name: string) => {
    this.statusWrites += 1;
    this.statusKeys.add(`${sha}:${name}`);
    return "status-1";
  };
}
