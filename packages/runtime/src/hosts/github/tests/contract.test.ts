import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildPublicationPlan, runtimeVersion } from "../../../review/comment.js";
import { buildPriorReviewState, renderInlineFindingMarker } from "../../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../../types.js";
import { runCodeHostAdapterContract } from "../../tests/adapter-contract.js";
import { createGitHubHostAdapter } from "../adapter.js";
import type { GitHubCommandClient } from "../command.js";
import type { GitHubPublicationClient } from "../publication.js";

describe("GitHub host adapter contract", () => {
  it("normalizes native event fixtures through provider-neutral surfaces", async () => {
    await withEventFile("pull_request", pullRequestPayload(), async ({ eventPath, rootDir }) => {
      const adapter = createGitHubHostAdapter({
        env: githubEnv("pull_request", rootDir),
        commandClient: commandClient(),
        publicationClient: publicationClient(),
      });

      await expect(
        adapter.events.parseEvent({
          eventPath,
          env: githubEnv("pull_request", rootDir),
          workspace: rootDir,
        }),
      ).resolves.toMatchObject({
        kind: "change-request",
        change: {
          action: "opened",
          platform: { id: "github" },
          repository: { slug: "local/pipr" },
          change: { number: 7, base: { sha: "base" }, head: { sha: "head" } },
        },
      });
    });

    await withEventFile("issue_comment", issueCommentPayload(), async ({ eventPath, rootDir }) => {
      const adapter = createGitHubHostAdapter({
        env: githubEnv("issue_comment", rootDir),
        commandClient: commandClient(),
        publicationClient: publicationClient(),
      });

      await expect(
        adapter.events.parseEvent({
          eventPath,
          env: githubEnv("issue_comment", rootDir),
          workspace: rootDir,
        }),
      ).resolves.toMatchObject({
        kind: "command-comment",
        comment: {
          eventName: "issue_comment",
          changeNumber: 7,
          commentId: "123",
          isChangeRequest: true,
          body: "@pipr review",
          actor: "octo-dev",
        },
      });
    });

    await withEventFile(
      "pull_request_review_comment",
      reviewCommentPayload(),
      async ({ eventPath, rootDir }) => {
        const adapter = createGitHubHostAdapter({
          env: githubEnv("pull_request_review_comment", rootDir),
          commandClient: commandClient(),
          publicationClient: publicationClient(),
        });

        await expect(
          adapter.events.parseEvent({
            eventPath,
            env: githubEnv("pull_request_review_comment", rootDir),
            workspace: rootDir,
          }),
        ).resolves.toMatchObject({
          kind: "review-comment-reply",
          reply: {
            eventName: "pull_request_review_comment",
            changeNumber: 7,
            commentId: "456",
            parentCommentId: "123",
            body: "Still applies.",
            actor: "octo-dev",
          },
        });
      },
    );
  });

  it("routes command, permission, publication, comments, and checks through adapter clients", async () => {
    const calls: string[] = [];
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(calls),
      publicationClient: publicationClient(calls),
    });
    const loadedChange = await adapter.events.loadChangeRequest({
      repository: { slug: "fallback/repo" },
      changeNumber: 7,
      eventName: "pull_request",
      action: "opened",
      rawAction: "opened",
      workspace: "/workspace",
    });
    const change = changeEvent(loadedChange);

    await expect(
      adapter.permissions.getRepositoryPermission({
        change,
        actor: "octo-dev",
      }),
    ).resolves.toBe("maintain");
    await expect(adapter.comments?.loadPriorReviewState?.({ change })).resolves.toBeUndefined();
    await expect(adapter.comments?.loadPriorMainComment?.({ change })).resolves.toBeUndefined();
    await expect(adapter.comments?.loadInlineThreadContexts?.({ change })).resolves.toEqual([]);
    await expect(
      adapter.publication?.publishCommandResponse?.({
        change,
        sourceCommentId: "123",
        commandName: "review",
        body: "Queued.",
      }),
    ).resolves.toEqual({ action: "created", id: "1" });
    const checkRun = await adapter.statuses?.upsert({
      change,
      name: "pipr",
      state: "pending",
      summary: "Running.",
    });
    expect(checkRun).toEqual({ id: "9", name: "pipr" });
    await expect(
      adapter.statuses?.upsert({
        change,
        name: "pipr",
        state: "pending",
        summary: "Still running.",
      }),
    ).resolves.toEqual({ id: "9", name: "pipr" });
    await adapter.statuses?.upsert({
      change,
      name: "pipr",
      status: { id: "9", name: "pipr" },
      state: "success",
      summary: "Done.",
    });

    expect(calls).toContain("getPullRequest");
    expect(calls).toContain("getRepositoryPermission");
    expect(calls).toContain("listReviewComments");
    expect(calls).toContain("listReviewThreads");
    expect(calls).toContain("getPullRequestHeadSha");
    expect(calls).toContain("createIssueComment");
    expect(calls).toContain("createCheckRun");
    expect(calls.filter((call) => call === "createCheckRun")).toHaveLength(1);
    expect(calls).toContain("updateCheckRun");
  });

  it("prevents stale publication through the contract publication surface", async () => {
    const calls: string[] = [];
    const adapter = createGitHubHostAdapter({
      env: {},
      commandClient: commandClient(),
      publicationClient: publicationClient(calls, { headSha: "new-head" }),
    });
    const loadedChange = await adapter.events.loadChangeRequest({
      repository: { slug: "local/pipr" },
      changeNumber: 7,
    });
    const change = changeEvent(loadedChange);

    await expect(
      adapter.publication?.publish({
        change,
        plan: buildPublicationPlan({
          event: change,
          main: "No findings.",
          inlineItems: [],
          metadata: {
            runtimeVersion,
            reviewedHeadSha: "head",
            selectedTasks: ["review"],
            failedTasks: [],
            validFindings: 0,
            droppedFindings: 0,
          },
        }),
      }),
    ).rejects.toThrow("Change request head changed");
    expect(calls).toEqual(["getPullRequestHeadSha"]);
  });
});

runCodeHostAdapterContract("GitHub", {
  async pagination() {
    const change = githubContractChange();
    const client = new StatefulPublicationClient();
    const adapter = createGitHubHostAdapter({ publicationClient: client });
    await adapter.publication?.publish({ change, plan: githubContractPlan(change) });
    await adapter.publication?.publish({
      change,
      plan: githubContractPlan(change, "fnd_bbbbbbbbbbbbbbbb"),
    });
    return (await adapter.comments?.loadInlineThreadContexts?.({ change }))?.length ?? 0;
  },
  async staleHeadWrites() {
    const change = githubContractChange();
    const client = new StatefulPublicationClient();
    client.headSha = "new-head";
    await createGitHubHostAdapter({ publicationClient: client })
      .publication?.publish({ change, plan: githubContractPlan(change) })
      .catch(() => undefined);
    return client.issueComments.length + client.reviewComments.length;
  },
  async partialRetry() {
    const change = githubContractChange();
    const client = new StatefulPublicationClient();
    client.loseNextInlineResponse = true;
    await createGitHubHostAdapter({ publicationClient: client }).publication?.publish({
      change,
      plan: githubContractPlan(change),
    });
    return { inlineWrites: client.reviewComments.length, mainWrites: client.issueComments.length };
  },
  async markerOwnership() {
    const change = githubContractChange();
    const client = new StatefulPublicationClient();
    client.addReviewComment(githubContractPlan(change).inlineItems[0]?.body ?? "", "someone-else");
    const adapter = createGitHubHostAdapter({ publicationClient: client });
    await adapter.publication?.publish({ change, plan: githubContractPlan(change) });
    const foreignWrites = client.reviewComments.filter(
      (comment) => comment.authorLogin === "someone-else",
    ).length;
    await adapter.publication?.publish({ change, plan: githubContractPlan(change) });
    const ownedWritesAfterRerun = client.reviewComments.filter(
      (comment) => comment.authorLogin === client.ownerLogin && comment.path,
    ).length;
    return { foreignWrites, ownedWritesAfterRerun };
  },
  async statusIdempotency() {
    const change = githubContractChange();
    const client = new StatefulPublicationClient();
    const statuses = createGitHubHostAdapter({ publicationClient: client }).statuses;
    const firstStatus = await statuses?.upsert({ change, name: "review", state: "pending" });
    const secondStatus = await statuses?.upsert({ change, name: "review", state: "success" });
    if (!firstStatus || !secondStatus) throw new Error("Expected status support");
    return {
      firstId: firstStatus.id,
      secondId: secondStatus.id,
      nativeRecords: client.checkRuns.length,
      statusWrites: client.statusWrites,
    };
  },
  async threadActions() {
    const change = githubContractChange();
    const client = new StatefulPublicationClient();
    const publication = createGitHubHostAdapter({ publicationClient: client }).publication;
    await publication?.publish({ change, plan: githubContractPlan(change) });
    const action = githubResolveAction();
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
    return { replies: client.reviewReplies.length, resolutions: client.resolveCalls };
  },
});

function commandClient(calls: string[] = []): GitHubCommandClient {
  return {
    async getPullRequest() {
      calls.push("getPullRequest");
      return {
        repository: { slug: "local/pipr", url: "https://github.test/local/pipr" },
        change: {
          number: 7,
          title: "Adapter contract",
          description: "",
          url: "https://github.test/local/pipr/pull/7",
          author: { login: "octo-dev" },
          base: { sha: "base", ref: "main", url: "https://github.test/local/pipr" },
          head: { sha: "head", ref: "feature", url: "https://github.test/local/pipr" },
          isFork: false,
        },
      };
    },
    async getRepositoryPermission() {
      calls.push("getRepositoryPermission");
      return "maintain";
    },
  };
}

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

function publicationClient(
  calls: string[] = [],
  options: { headSha?: string } = {},
): GitHubPublicationClient {
  const checkRuns: Array<{ id: number; name: string; externalId?: string }> = [];
  return {
    async getAuthenticatedUserLogin() {
      calls.push("getAuthenticatedUserLogin");
      return "github-actions[bot]";
    },
    async getPullRequestHeadSha() {
      calls.push("getPullRequestHeadSha");
      return options.headSha ?? "head";
    },
    async listIssueComments() {
      calls.push("listIssueComments");
      return [];
    },
    async createIssueComment() {
      calls.push("createIssueComment");
      return { id: 1 };
    },
    async updateIssueComment() {
      calls.push("updateIssueComment");
      return { id: 1 };
    },
    async listReviewComments() {
      calls.push("listReviewComments");
      return [];
    },
    async listReviewThreads() {
      calls.push("listReviewThreads");
      return [];
    },
    async createReviewComment() {
      calls.push("createReviewComment");
      return { id: 1 };
    },
    async createReviewCommentReply() {
      calls.push("createReviewCommentReply");
      return { id: 1 };
    },
    async resolveReviewThread() {
      calls.push("resolveReviewThread");
    },
    async createCheckRun(options) {
      calls.push("createCheckRun");
      const checkRun = { id: 9, name: options.name, externalId: options.externalId };
      checkRuns.push(checkRun);
      return checkRun;
    },
    async listCheckRuns() {
      calls.push("listCheckRuns");
      return checkRuns;
    },
    async updateCheckRun() {
      calls.push("updateCheckRun");
    },
  };
}

function githubContractChange(): ChangeRequestEventContext {
  return {
    eventName: "pull_request",
    action: "updated",
    platform: { id: "github" },
    repository: { slug: "local/pipr" },
    coordinates: { provider: "github", owner: "local", repository: "pipr" },
    change: {
      number: 7,
      title: "Adapter contract",
      description: "",
      base: { sha: "base", ref: "main" },
      head: { sha: "head", ref: "feature" },
    },
    workspace: "/workspace",
  };
}

function githubContractPlan(change: ChangeRequestEventContext, findingId = "fnd_aaaaaaaaaaaaaaaa") {
  const line = findingId === "fnd_bbbbbbbbbbbbbbbb" ? 3 : 2;
  const finding = {
    body: "Fix this.",
    path: "src/a.ts",
    rangeId: `range-${findingId}`,
    side: "RIGHT" as const,
    startLine: line,
    endLine: line,
  };
  const marker = `pipr:finding:${findingId}:head`;
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems: [
      {
        finding,
        range: {
          id: finding.rangeId,
          path: "src/a.ts",
          side: "RIGHT",
          startLine: line,
          endLine: line,
          kind: "added",
          hunkIndex: 1,
          hunkHeader: "@@ -1 +1,2 @@",
          hunkContentHash: "deadbeefcafe",
        },
        path: "src/a.ts",
        side: "RIGHT",
        startLine: line,
        endLine: line,
        body: `${renderInlineFindingMarker(findingId, "head")}\nFix this.`,
        marker,
        findingId,
        reviewedHeadSha: "head",
      },
    ],
    reviewState: buildPriorReviewState({
      findings: [finding],
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
    }),
    metadata: {
      runtimeVersion,
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: 1,
      droppedFindings: 0,
    },
  });
}

function githubResolveAction() {
  return {
    kind: "resolve" as const,
    findingId: "finding-1",
    findingHeadSha: "head",
    commentId: "1",
    threadId: "thread-1",
    body: "Resolved. response-key",
    responseKey: "response-key",
  };
}

type StatefulReviewComment = Awaited<
  ReturnType<GitHubPublicationClient["listReviewComments"]>
>[number];
type StatefulReviewThread = Awaited<
  ReturnType<GitHubPublicationClient["listReviewThreads"]>
>[number];

class StatefulPublicationClient implements GitHubPublicationClient {
  readonly ownerLogin = "github-actions[bot]";
  headSha = "head";
  loseNextInlineResponse = false;
  resolveCalls = 0;
  issueComments: Array<{ id: number; body: string; authorLogin: string | undefined }> = [];
  reviewComments: StatefulReviewComment[] = [];
  reviewThreads: StatefulReviewThread[] = [];
  reviewReplies: Array<{ commentId: number; body: string }> = [];
  checkRuns: Array<{ id: number; name: string; externalId?: string }> = [];
  statusWrites = 0;

  async getAuthenticatedUserLogin() {
    return this.ownerLogin;
  }

  async getPullRequestHeadSha() {
    return this.headSha;
  }

  async listIssueComments() {
    return this.issueComments;
  }

  async createIssueComment(options: { body: string }) {
    const comment = {
      id: this.issueComments.length + 1,
      body: options.body,
      authorLogin: this.ownerLogin,
    };
    this.issueComments.push(comment);
    return { id: comment.id };
  }

  async updateIssueComment(options: { commentId: number; body: string }) {
    const comment = this.issueComments.find((candidate) => candidate.id === options.commentId);
    if (!comment) throw new Error("missing issue comment");
    comment.body = options.body;
    return { id: comment.id };
  }

  async listReviewComments() {
    return this.reviewComments;
  }

  async listReviewThreads() {
    return this.reviewThreads;
  }

  addReviewComment(body: string, authorLogin = this.ownerLogin, line = 2) {
    const id = this.reviewComments.length + 1;
    this.reviewComments.push({
      id,
      body,
      authorLogin,
      path: "src/a.ts",
      commitId: "head",
      line,
      startLine: undefined,
      side: "RIGHT",
      startSide: undefined,
    });
    this.reviewThreads.push({ id: `thread-${id}`, isResolved: false, commentIds: [id] });
    return id;
  }

  async createReviewComment(options: unknown) {
    const payload = options as { body: string; line?: number };
    const id = this.addReviewComment(payload.body, this.ownerLogin, payload.line);
    if (this.loseNextInlineResponse) {
      this.loseNextInlineResponse = false;
      throw Object.assign(new Error("response lost"), { status: 503 });
    }
    return { id };
  }

  async createReviewCommentReply(options: { commentId: number; body: string }) {
    this.reviewReplies.push(options);
    const id = this.reviewComments.length + 1;
    this.reviewComments.push({
      id,
      body: options.body,
      authorLogin: this.ownerLogin,
      path: undefined,
      commitId: undefined,
      line: undefined,
      startLine: undefined,
      side: undefined,
      startSide: undefined,
    });
    this.reviewThreads
      .find((thread) => thread.commentIds.includes(options.commentId))
      ?.commentIds.push(id);
    return { id };
  }

  async resolveReviewThread(options: { threadId: string }) {
    this.resolveCalls += 1;
    const thread = this.reviewThreads.find((candidate) => candidate.id === options.threadId);
    if (!thread) throw new Error("missing review thread");
    thread.isResolved = true;
  }

  async createCheckRun(options: { name: string; externalId?: string }) {
    this.statusWrites += 1;
    const check = {
      id: this.checkRuns.length + 1,
      name: options.name,
      externalId: options.externalId,
    };
    this.checkRuns.push(check);
    return check;
  }

  async listCheckRuns() {
    return this.checkRuns;
  }

  async updateCheckRun() {
    this.statusWrites += 1;
  }
}

async function withEventFile(
  name: string,
  payload: unknown,
  run: (options: { eventPath: string; rootDir: string }) => Promise<void>,
): Promise<void> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), `pipr-${name}-`));
  try {
    const eventPath = path.join(rootDir, "event.json");
    await Bun.write(eventPath, JSON.stringify(payload));
    await run({ eventPath, rootDir });
  } finally {
    await rm(rootDir, { force: true, recursive: true });
  }
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
