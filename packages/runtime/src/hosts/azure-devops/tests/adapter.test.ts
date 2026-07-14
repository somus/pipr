import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPublicationPlan, type InlinePublicationItem } from "../../../review/comment.js";
import { buildPriorReviewState, renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { createAzureDevOpsHostAdapter } from "../adapter.js";
import type { AzureDevOpsClient, AzureDevOpsPullRequest, AzureDevOpsThread } from "../client.js";

const fixtureWorkspace = mkdtempSync(path.join(os.tmpdir(), "pipr-azure-adapter-"));
git(fixtureWorkspace, ["init"]);
git(fixtureWorkspace, ["config", "user.name", "Pipr Test"]);
git(fixtureWorkspace, ["config", "user.email", "pipr@example.test"]);
mkdirSync(path.join(fixtureWorkspace, "src"));
writeFileSync(path.join(fixtureWorkspace, "src/a.ts"), "line one\n\n");
writeFileSync(path.join(fixtureWorkspace, "src/old.ts"), "one\ntwo\nthree\nfour\n\n");
git(fixtureWorkspace, ["add", "."]);
git(fixtureWorkspace, ["commit", "-m", "fixture"]);
git(fixtureWorkspace, ["tag", "base"]);

afterAll(() => rmSync(fixtureWorkspace, { recursive: true, force: true }));

describe("Azure DevOps host adapter", () => {
  it("publishes idempotent main, iteration-anchored inline, and status results", async () => {
    const client = new FakeAzureDevOpsClient();
    const adapter = createAzureDevOpsHostAdapter({ client });
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
    expect(client.createdThreadBodies[1]).toMatchObject({
      threadContext: {
        filePath: "/src/a.ts",
        rightFileStart: { line: 2, offset: 1 },
        rightFileEnd: { line: 2, offset: 1 },
      },
      pullRequestThreadContext: {
        changeTrackingId: 11,
        iterationContext: { firstComparingIteration: 1, secondComparingIteration: 2 },
      },
    });
    expect(status).toEqual({ id: "status-1", name: "review" });
    expect(client.statusBodies[0]).toMatchObject({
      state: "succeeded",
      context: { genre: "pipr", name: "pipr/review" },
      iterationId: 2,
    });
  });

  it("fails stale publication before any Azure write", async () => {
    const client = new FakeAzureDevOpsClient();
    client.pullRequest = {
      ...client.pullRequest,
      lastMergeSourceCommit: { commitId: "new-head" },
    };
    const adapter = createAzureDevOpsHostAdapter({ client });

    await expect(adapter.publication?.publish({ change, plan: publicationPlan() })).rejects.toThrow(
      "head changed",
    );
    expect(client.threads).toEqual([]);
  });

  it("reports an inline publication failure when the reviewed blob cannot be read", async () => {
    const client = new FakeAzureDevOpsClient();
    const adapter = createAzureDevOpsHostAdapter({ client });
    const missingWorkspaceChange = {
      ...change,
      workspace: path.join(fixtureWorkspace, "missing"),
    };

    await expect(
      adapter.publication?.publish({ change: missingWorkspaceChange, plan: publicationPlan() }),
    ).rejects.toMatchObject({
      message: "Azure DevOps inline comment publication failed",
      result: { inlineComments: { posted: 0, skipped: 0, failed: 1 } },
    });
    expect(client.createdThreadBodies).toHaveLength(1);
  });

  it("fails publication and statuses when only the target commit changed", async () => {
    const client = new FakeAzureDevOpsClient();
    client.pullRequest = {
      ...client.pullRequest,
      lastMergeTargetCommit: { commitId: "new-base" },
    };
    const adapter = createAzureDevOpsHostAdapter({ client });

    await expect(adapter.publication?.publish({ change, plan: publicationPlan() })).rejects.toThrow(
      "base changed",
    );
    await expect(
      adapter.statuses?.upsert({ change, name: "review", state: "success" }),
    ).rejects.toThrow("endpoints changed");
    expect(client.threads).toEqual([]);
    expect(client.statusBodies).toEqual([]);
  });

  it("loads prior state and inline contexts", async () => {
    const client = new FakeAzureDevOpsClient();
    const adapter = createAzureDevOpsHostAdapter({ client });
    const publication = adapter.publication;
    const comments = adapter.comments;
    if (!publication || !comments) throw new Error("Expected Azure publication surfaces");
    await publication.publish({ change, plan: publicationPlan() });

    await expect(comments.loadPriorReviewState?.({ change })).resolves.toMatchObject({
      reviewedHeadSha: "head",
    });
    await expect(comments.loadInlineThreadContexts?.({ change })).resolves.toMatchObject([
      { findingId: "finding-1", findingHeadSha: "head", threadResolved: false },
    ]);
  });

  it("resolves threads idempotently", async () => {
    const client = new FakeAzureDevOpsClient();
    const publication = createAzureDevOpsHostAdapter({ client }).publication;
    if (!publication?.publishThreadActions)
      throw new Error("Expected Azure thread-action publication");
    await publication.publish({ change, plan: publicationPlan() });
    const inline = client.threads.find((thread) => thread.threadContext?.filePath);
    if (!inline) throw new Error("Expected inline thread");
    await publication.publishThreadActions({
      change,
      reviewedHeadSha: "head",
      actions: [
        {
          kind: "resolve",
          findingId: "finding-1",
          findingHeadSha: "head",
          commentId: inline.comments[0]?.id ?? "",
          threadId: inline.id,
          body: "Resolved.\nhead:fixed:finding-1",
          responseKey: "head:fixed:finding-1",
        },
      ],
    });
    await publication.publishThreadActions({
      change,
      reviewedHeadSha: "head",
      actions: [
        {
          kind: "resolve",
          findingId: "finding-1",
          findingHeadSha: "head",
          commentId: inline.comments[0]?.id ?? "",
          threadId: inline.id,
          body: "Resolved.\nhead:fixed:finding-1",
          responseKey: "head:fixed:finding-1",
        },
      ],
    });
    expect(inline.comments).toHaveLength(2);
    expect(inline.status).toBe("fixed");
  });

  it.each([
    "fixed",
    "closed",
    "wontFix",
    "byDesign",
  ])("loads %s threads as resolved", async (status) => {
    const client = new FakeAzureDevOpsClient();
    const adapter = createAzureDevOpsHostAdapter({ client });
    await adapter.publication?.publish({ change, plan: publicationPlan() });
    const inline = client.threads.find((thread) => thread.threadContext?.filePath);
    if (!inline) throw new Error("Expected inline thread");
    inline.status = status;

    await expect(adapter.comments?.loadInlineThreadContexts?.({ change })).resolves.toMatchObject([
      { threadResolved: true },
    ]);
  });

  it("creates and updates one command response thread", async () => {
    const client = new FakeAzureDevOpsClient();
    const adapter = createAzureDevOpsHostAdapter({ client });
    const options = {
      change,
      sourceCommentId: "command-1",
      commandName: "ask",
      body: "First response",
    };

    await expect(adapter.publication?.publishCommandResponse?.(options)).resolves.toMatchObject({
      action: "created",
    });
    await expect(
      adapter.publication?.publishCommandResponse?.({ ...options, body: "Updated response" }),
    ).resolves.toMatchObject({ action: "updated" });
    expect(client.threads).toHaveLength(1);
    expect(client.threads[0]?.comments[0]?.content).toContain("Updated response");
    expect(client.listIterationsCalls).toBe(0);
  });

  it("anchors multiline renamed-file findings on the selected diff side", async () => {
    const client = new FakeAzureDevOpsClient();
    client.iterationChanges = [
      { changeTrackingId: 20, changeType: "delete", path: "src/old.ts" },
      { changeTrackingId: 21, changeType: "add", path: "src/new.ts" },
    ];
    const adapter = createAzureDevOpsHostAdapter({ client });
    const plan = publicationPlan();
    const item = plan.inlineItems[0];
    if (!item) throw new Error("Expected inline fixture");
    plan.inlineItems = [
      {
        ...item,
        finding: {
          ...item.finding,
          path: "src/new.ts",
          side: "LEFT",
          startLine: 3,
          endLine: 5,
        },
        range: { ...item.range, path: "src/new.ts", side: "LEFT", startLine: 3, endLine: 5 },
        path: "src/new.ts",
        previousPath: "src/old.ts",
        side: "LEFT",
        startLine: 3,
        endLine: 5,
      },
    ];

    await adapter.publication?.publish({ change, plan });
    expect(client.createdThreadBodies[1]).toMatchObject({
      threadContext: {
        filePath: "/src/old.ts",
        leftFileStart: { line: 3, offset: 1 },
        leftFileEnd: { line: 5, offset: 1 },
      },
      pullRequestThreadContext: { changeTrackingId: 20 },
    });
  });

  it("publishes visible suggestion fallbacks in a positioned thread", async () => {
    const client = new FakeAzureDevOpsClient();
    const adapter = createAzureDevOpsHostAdapter({ client });
    const plan = publicationPlan();
    const item = plan.inlineItems[0];
    if (!item) throw new Error("Expected inline fixture");
    plan.inlineItems = [
      {
        ...item,
        finding: { ...item.finding, suggestedFix: "const value = 2;" },
        body: `${item.body}\n**Suggested change**\n\n\`\`\`\nconst value = 2;\n\`\`\``,
      },
    ];

    await adapter.publication?.publish({ change, plan });

    expect(client.createdThreadBodies[1]).toMatchObject({
      threadContext: {
        filePath: "/src/a.ts",
        rightFileStart: { line: 2, offset: 1 },
        rightFileEnd: { line: 2, offset: 1 },
      },
    });
    const comments = client.createdThreadBodies[1]?.comments as
      | Array<{ content: string }>
      | undefined;
    expect(comments?.[0]?.content).toContain("```\nconst value = 2;\n```");
  });

  it("declares Azure-native capability limits", () => {
    const adapter = createAzureDevOpsHostAdapter({ client: new FakeAzureDevOpsClient() });
    expect(adapter.capabilities).toEqual({
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: false,
      statuses: true,
    });
  });

  it("uses one-based UTF-16 end offsets from the reviewed commit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-azure-offset-"));
    try {
      git(workspace, ["init"]);
      git(workspace, ["config", "user.name", "Pipr Test"]);
      git(workspace, ["config", "user.email", "pipr@example.test"]);
      await Bun.write(path.join(workspace, "src-a.ts"), "café naïve 🙂\n");
      git(workspace, ["add", "src-a.ts"]);
      git(workspace, ["commit", "-m", "unicode"]);
      const sha = git(workspace, ["rev-parse", "HEAD"]).trim();
      const client = new FakeAzureDevOpsClient();
      client.headSha = sha;
      client.pullRequest = {
        ...client.pullRequest,
        lastMergeSourceCommit: { commitId: sha },
        lastMergeTargetCommit: { commitId: sha },
      };
      client.iterationChanges = [{ changeTrackingId: 12, changeType: "edit", path: "src-a.ts" }];
      const unicodeChange: ChangeRequestEventContext = {
        ...change,
        change: {
          ...change.change,
          base: { sha, ref: "main" },
          head: { sha, ref: "feature" },
        },
        workspace,
      };
      const plan = publicationPlan();
      const item = plan.inlineItems[0];
      if (!item) throw new Error("Expected inline fixture");
      plan.inlineItems = [
        {
          ...item,
          finding: { ...item.finding, path: "src-a.ts", startLine: 1, endLine: 1 },
          range: { ...item.range, path: "src-a.ts", startLine: 1, endLine: 1 },
          path: "src-a.ts",
          startLine: 1,
          endLine: 1,
        },
      ];

      await createAzureDevOpsHostAdapter({ client }).publication?.publish({
        change: unicodeChange,
        plan,
      });
      expect(client.createdThreadBodies[1]).toMatchObject({
        threadContext: { rightFileEnd: { line: 1, offset: 14 } },
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});

const change: ChangeRequestEventContext = {
  eventName: "azure_pipeline",
  action: "updated",
  platform: { id: "azure-devops", host: "https://dev.azure.com/org" },
  repository: { slug: "org/project/repository" },
  coordinates: {
    provider: "azure-devops",
    organization: "org",
    project: "project",
    projectId: "project-id",
    repositoryId: "repo-id",
  },
  change: {
    number: 7,
    title: "Test PR",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
  workspace: fixtureWorkspace,
};

function publicationPlan() {
  const inlineItem: InlinePublicationItem = {
    finding: {
      body: "Fix this.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
    },
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
    findingId: "finding-1",
    reviewedHeadSha: "head",
    marker: "pipr:finding:finding-1:head",
    body: `${renderInlineFindingMarker("finding-1", "head")}\nFix this.`,
  };
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems: [inlineItem],
    reviewState: buildPriorReviewState({
      findings: [inlineItem.finding],
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

class FakeAzureDevOpsClient implements AzureDevOpsClient {
  organization = "org";
  project = "project";
  threads: AzureDevOpsThread[] = [];
  createdThreadBodies: Array<Record<string, unknown>> = [];
  statusBodies: Array<Record<string, unknown>> = [];
  headSha = "head";
  iterationChanges = [{ changeTrackingId: 11, changeType: "edit", path: "src/a.ts" }];
  listIterationsCalls = 0;
  pullRequest: AzureDevOpsPullRequest = {
    pullRequestId: 7,
    title: "Test PR",
    description: "",
    sourceRefName: "refs/heads/feature",
    targetRefName: "refs/heads/main",
    lastMergeSourceCommit: { commitId: "head" },
    lastMergeTargetCommit: { commitId: "base" },
    repository: {
      id: "repo-id",
      name: "repository",
      project: { id: "project-id", name: "project" },
    },
  };
  currentUser = async () => ({ uniqueName: "pipr@example.com" });
  getRepository = async () => ({
    id: "repo-id",
    name: "repository",
    projectId: "project-id",
    project: "project",
  });
  getRepositoryPermission = async () => "write" as const;
  getPullRequest = async () => this.pullRequest;
  loadChange = async () => ({
    repository: change.repository,
    coordinates: {
      provider: "azure-devops" as const,
      organization: "org",
      project: "project",
      projectId: "project-id",
      repositoryId: "repo-id",
    },
    change: change.change,
    iterationId: 2,
  });
  listIterations = async () => {
    this.listIterationsCalls += 1;
    return [
      { id: 1, headSha: "old-head" },
      { id: 2, headSha: this.headSha },
    ];
  };
  listIterationChanges = async () => this.iterationChanges;
  listThreads = async () => this.threads;
  createThread = async (
    _repositoryId: string,
    _changeNumber: number,
    body: Record<string, unknown>,
  ) => {
    this.createdThreadBodies.push(body);
    const comments = body.comments as Array<{ content: string }>;
    const thread: AzureDevOpsThread = {
      id: String(this.threads.length + 1),
      status: "active",
      comments: [
        {
          id: String(this.threads.length + 10),
          content: comments[0]?.content ?? "",
          author: { uniqueName: "pipr@example.com" },
        },
      ],
      threadContext: body.threadContext as AzureDevOpsThread["threadContext"],
      pullRequestThreadContext:
        body.pullRequestThreadContext as AzureDevOpsThread["pullRequestThreadContext"],
    };
    this.threads.push(thread);
    return thread;
  };
  updateComment = async (
    _repositoryId: string,
    _changeNumber: number,
    threadId: string,
    commentId: string,
    content: string,
  ) => {
    const comment = this.threads.find((thread) => thread.id === threadId)?.comments[0];
    if (!comment || comment.id !== commentId) throw new Error("comment not found");
    comment.content = content;
    return comment;
  };
  createThreadComment = async (
    _repositoryId: string,
    _changeNumber: number,
    threadId: string,
    body: Record<string, unknown>,
  ) => {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("thread not found");
    const comment = {
      id: String(thread.comments.length + 20),
      content: String(body.content),
      author: { uniqueName: "pipr@example.com" },
    };
    thread.comments.push(comment);
    return comment;
  };
  updateThreadStatus = async (
    _repositoryId: string,
    _changeNumber: number,
    threadId: string,
    status: string,
  ) => {
    const thread = this.threads.find((candidate) => candidate.id === threadId);
    if (!thread) throw new Error("thread not found");
    thread.status = status;
    return thread;
  };
  createStatus = async (
    _repositoryId: string,
    _changeNumber: number,
    body: Record<string, unknown>,
  ) => {
    this.statusBodies.push(body);
    return "status-1";
  };
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
