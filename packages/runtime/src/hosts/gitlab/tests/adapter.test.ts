import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPublicationPlan, type InlinePublicationItem } from "../../../review/comment.js";
import { buildPriorReviewState, renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import {
  type CodeHostAdapterConformanceHarness,
  defineCodeHostAdapterConformanceSuite,
} from "../../tests/conformance.js";
import type { CodeHostStatusState, RepositoryPermission } from "../../types.js";
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

defineCodeHostAdapterConformanceSuite({
  name: "GitLab",
  createHarness: createGitLabConformanceHarness,
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
      findings: [{ finding }],
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
  createDiscussionError?: Error;
  afterListNotes?: () => void;
  permission: RepositoryPermission = "write";
  permissionActors: string[] = [];
  mainCreates = 0;
  mainUpdates = 0;
  commandCreates = 0;
  commandUpdates = 0;
  statusWrites: Array<{
    name: string;
    state: CodeHostStatusState;
    summary?: string;
    headSha: string;
  }> = [];
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
  getRepositoryPermission = async (_projectId: string, actor: string) => {
    this.permissionActors.push(actor);
    return this.permission;
  };
  listNotes = async () => {
    const notes = this.notes;
    this.afterListNotes?.();
    return notes;
  };
  createNote = async (_projectId: string, _changeNumber: number, body: string) => {
    if (body.includes("pipr:command-response")) this.commandCreates += 1;
    else this.mainCreates += 1;
    const note = {
      id: String(this.notes.length + 1),
      body,
      author: { id: 1, username: "pipr-bot" },
    };
    this.notes.push(note);
    return note;
  };
  updateNote = async (_projectId: string, _changeNumber: number, noteId: string, body: string) => {
    if (body.includes("pipr:command-response")) this.commandUpdates += 1;
    else this.mainUpdates += 1;
    const note = this.notes.find((candidate) => candidate.id === noteId);
    if (!note) throw new Error(`Unknown note ${noteId}`);
    note.body = body;
    return note;
  };
  listDiscussions = async () => {
    const discussions = this.discussions;
    this.afterListNotes?.();
    return discussions;
  };
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
    if (this.createDiscussionError) {
      const error = this.createDiscussionError;
      this.createDiscussionError = undefined;
      throw error;
    }
    const discussion: GitLabDiscussion = {
      id: `discussion-${this.discussions.length + 1}`,
      notes: [
        {
          id: `inline-${this.discussions.length + 1}`,
          body,
          author: { id: 1, username: "pipr-bot" },
          resolved: false,
          position: {
            new_path: position.new_path,
            old_path: position.old_path,
            new_line: position.new_line,
            old_line: position.old_line,
            line_range: position.line_range,
          },
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
  setStatus = async (
    _projectId: string,
    headSha: string,
    name: string,
    state: CodeHostStatusState,
    summary?: string,
  ) => {
    this.statusWrites.push({ name, state, summary, headSha });
    return "status-1";
  };
}

async function createGitLabConformanceHarness(): Promise<CodeHostAdapterConformanceHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-gitlab-conformance-"));
  const client = new FakeGitLabClient();
  const adapter = createGitLabHostAdapter({ client });
  return {
    adapter,
    change,
    async events() {
      const eventPath = path.join(root, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          object_kind: "merge_request",
          project: { id: 42, path_with_namespace: "group/project", web_url: "https://gitlab.com" },
          object_attributes: { iid: 7, action: "open", draft: false },
        }),
      );
      const changeRequest = await adapter.events.parseEvent({
        eventPath,
        env: {},
        workspace: root,
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          object_kind: "note",
          project: { id: 42, path_with_namespace: "group/project" },
          merge_request: { iid: 7 },
          user: { username: "developer" },
          object_attributes: {
            id: 101,
            note: "@pipr review",
            action: "create",
            noteable_type: "MergeRequest",
          },
        }),
      );
      const command = await adapter.events.parseEvent({ eventPath, env: {}, workspace: root });
      client.discussions.push({
        id: "discussion-event",
        notes: [
          { id: "101", body: "root", author: { id: 2, username: "developer" } },
          { id: "102", body: "Fixed.", author: { id: 2, username: "developer" } },
        ],
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          object_kind: "note",
          project: { id: 42, path_with_namespace: "group/project" },
          merge_request: { iid: 7 },
          user: { username: "developer" },
          object_attributes: {
            id: 102,
            note: "Fixed.",
            action: "create",
            noteable_type: "MergeRequest",
            discussion_id: "discussion-event",
          },
        }),
      );
      const reply = await adapter.events.parseEvent({ eventPath, env: {}, workspace: root });
      await Bun.write(
        eventPath,
        JSON.stringify({
          object_kind: "merge_request",
          project: { id: 42, path_with_namespace: "group/project" },
          object_attributes: { iid: 7, action: "open", draft: true },
        }),
      );
      const draft = await adapter.events.parseEvent({ eventPath, env: {}, workspace: root });
      return { changeRequest, command, reply, draft };
    },
    setPermission(permission) {
      client.permission = permission;
    },
    permissionRequests: () => client.permissionActors.map((actor) => ({ actor })),
    setCurrentHead(headSha) {
      client.mergeRequest = {
        ...client.mergeRequest,
        sha: headSha,
        diff_refs: { ...client.mergeRequest.diff_refs, head_sha: headSha },
      };
    },
    advanceHeadDuringPreflight() {
      client.afterListNotes = () => {
        client.afterListNotes = undefined;
        client.mergeRequest = {
          ...client.mergeRequest,
          sha: "new-head",
          diff_refs: { ...client.mergeRequest.diff_refs, head_sha: "new-head" },
        };
      };
    },
    failNextInline() {
      client.createDiscussionError = new Error("GitLab rejected the position");
    },
    seedForeignInline() {
      client.discussions.push({
        id: "discussion-foreign",
        notes: [
          {
            id: "inline-foreign",
            body: `${renderInlineFindingMarker("foreign", "head")}\nForeign.`,
            author: { id: 2, username: "developer" },
            resolved: false,
            position: {
              new_path: "src/new.ts",
              old_path: "src/new.ts",
              new_line: 4,
              old_line: undefined,
              line_range: {
                start: { new_line: 2 },
                end: { new_line: 4 },
              },
            },
          },
        ],
      });
    },
    seedForeignReply(body) {
      const discussion = client.discussions.find(
        (item) => item.notes[0]?.author?.username === "pipr-bot",
      );
      if (!discussion) throw new Error("GitLab conformance discussion not found");
      discussion.notes.push({
        id: "reply-foreign",
        body,
        author: { id: 2, username: "developer" },
      });
    },
    setFirstInlineResolved(resolved) {
      const root = client.discussions.find(
        (item) => item.notes[0]?.author?.username === "pipr-bot" && item.notes[0]?.position,
      )?.notes[0];
      if (!root) throw new Error("GitLab conformance discussion not found");
      root.resolved = resolved;
    },
    ownedReplyBodies: () =>
      client.discussions.flatMap((item) =>
        item.notes
          .slice(1)
          .filter((note) => note.author?.username === "pipr-bot")
          .map((note) => note.body),
      ),
    writes: () => ({
      mainCreates: client.mainCreates,
      mainUpdates: client.mainUpdates,
      inlineCreates: client.discussions.filter(
        (item) => item.notes[0]?.author?.username === "pipr-bot" && item.notes[0]?.position,
      ).length,
      commandCreates: client.commandCreates,
      commandUpdates: client.commandUpdates,
      replies: client.discussions.reduce(
        (count, item) =>
          count + item.notes.slice(1).filter((note) => note.author?.username === "pipr-bot").length,
        0,
      ),
      resolutions: client.discussions.filter(
        (item) => item.id !== "discussion-event" && item.notes[0]?.resolved,
      ).length,
    }),
    anchors: () => client.positions.map(observedGitLabAnchor),
    statuses: () => client.statusWrites,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function observedGitLabAnchor(position: GitLabPosition) {
  const range = position.line_range;
  if (position.new_line !== undefined) {
    return {
      path: position.new_path,
      side: "RIGHT" as const,
      startLine: range?.start.new_line ?? position.new_line,
      endLine: position.new_line,
      headSha: position.head_sha,
    };
  }
  return {
    path: position.new_path,
    ...(position.old_path !== position.new_path ? { previousPath: position.old_path } : {}),
    side: "LEFT" as const,
    startLine: range?.start.old_line ?? position.old_line ?? 0,
    endLine: position.old_line ?? 0,
    headSha: position.head_sha,
  };
}
