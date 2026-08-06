import { describe, expect, it } from "bun:test";
import {
  buildPublicationPlan,
  type InlinePublicationItem,
  runtimeVersion,
  type ThreadAction,
} from "../../review/comment.js";
import {
  renderInlineFindingMarker,
  renderVerifierResponseMarker,
} from "../../review/prior-state.js";
import type { ReviewProgressLease } from "../../review/progress.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  createPublicationWorkflow,
  type LoadedPublicationState,
  type OwnedMainComment,
  type PublicationDriver,
} from "../publication/workflow.js";

const change = {
  repository: { slug: "acme/widget" },
  change: {
    number: 42,
    base: { sha: "base" },
    head: { sha: "head" },
    isDraft: false,
  },
  workspace: "/tmp",
} as ChangeRequestEventContext;

const progressToken = "11111111-1111-4111-8111-111111111111";
const newerToken = "22222222-2222-4222-8222-222222222222";

type Prepared = { change: ChangeRequestEventContext };

class MemoryDriver implements PublicationDriver<Prepared> {
  readonly provider = "Memory";
  currentHead = "head";
  writes: string[] = [];
  state: LoadedPublicationState = { inline: [], threads: [] };
  command?: OwnedMainComment;
  commandBody?: string;
  loadCount = 0;
  changeHeadOnLoad?: number;
  supersedeOnLoad?: number;
  failInline = 0;

  async prepare(input: ChangeRequestEventContext): Promise<Prepared> {
    return { change: input };
  }

  async assertCurrent(_prepared: Prepared, expectedHeadSha: string): Promise<void> {
    if (this.currentHead !== expectedHeadSha) throw new Error("head changed");
  }

  async loadOwnedState(): Promise<LoadedPublicationState> {
    this.loadCount += 1;
    if (this.changeHeadOnLoad === this.loadCount) this.currentHead = "new-head";
    if (this.supersedeOnLoad === this.loadCount && this.state.main) {
      this.state.main.body = progressBody(newerToken);
    }
    return this.state;
  }

  async loadOwnedMain(): Promise<OwnedMainComment | undefined> {
    this.loadCount += 1;
    if (this.changeHeadOnLoad === this.loadCount) this.currentHead = "new-head";
    if (this.supersedeOnLoad === this.loadCount && this.state.main) {
      this.state.main.body = progressBody(newerToken);
    }
    return this.state.main;
  }

  async upsertMain(_prepared: Prepared, existing: OwnedMainComment | undefined, body: string) {
    const id = existing?.id ?? "main-1";
    this.writes.push(existing ? "update-main" : "create-main");
    this.state = { ...this.state, main: { id, body } };
    return { id, action: existing ? ("updated" as const) : ("created" as const) };
  }

  inlineLocation(_prepared: Prepared, item: InlinePublicationItem) {
    return {
      path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
      commitId: item.reviewedHeadSha,
      side: item.side,
      startLine: item.startLine,
      endLine: item.endLine,
    };
  }

  async createInline(_prepared: Prepared, item: InlinePublicationItem): Promise<void> {
    if (this.failInline > 0) {
      this.failInline -= 1;
      throw new Error(`failed ${item.findingId}`);
    }
    this.writes.push(`inline:${item.findingId}`);
    const location = this.inlineLocation(_prepared, item);
    this.state = {
      ...this.state,
      inline: [...this.state.inline, { body: item.body, location, resolved: false }],
      threads: [
        ...this.state.threads,
        {
          findingId: item.findingId,
          findingHeadSha: item.reviewedHeadSha,
          parentCommentId: item.findingId,
          parentBody: item.body,
          threadId: `thread:${item.findingId}`,
          threadResolved: false,
          comments: [{ id: item.findingId, body: item.body, authorLogin: "pipr" }],
        },
      ],
    };
  }

  async loadOwnedCommand(): Promise<OwnedMainComment | undefined> {
    return this.command;
  }

  async upsertCommand(_prepared: Prepared, existing: OwnedMainComment | undefined, body: string) {
    this.command = { id: existing?.id ?? "command-1", body };
    this.commandBody = body;
    this.writes.push(existing ? "update-command" : "create-command");
    return { id: this.command.id, action: existing ? ("updated" as const) : ("created" as const) };
  }

  async replyThread(_prepared: Prepared, action: ThreadAction, _body: string): Promise<void> {
    this.writes.push(`reply:${action.findingId}`);
  }

  async resolveThread(_prepared: Prepared, action: ThreadAction) {
    this.writes.push(`resolve:${action.findingId}`);
    const thread = this.state.threads.find((item) => item.parentCommentId === action.commentId);
    if (thread) thread.threadResolved = true;
  }
}

describe("shared publication workflow", () => {
  it("rejects stale heads before writes and after preflight", async () => {
    const stale = new MemoryDriver();
    stale.currentHead = "new-head";
    await expect(publication(stale).publish({ change, plan: plan() })).rejects.toThrow(
      "head changed",
    );
    expect(stale.writes).toEqual([]);

    const raced = new MemoryDriver();
    raced.changeHeadOnLoad = 1;
    await expect(publication(raced).publish({ change, plan: plan() })).rejects.toThrow(
      "head changed",
    );
    expect(raced.writes).toEqual([]);
  });

  it("does not reclaim a progress token superseded during an update", async () => {
    const driver = new MemoryDriver();
    driver.state = { ...driver.state, main: { id: "main-1", body: progressBody(progressToken) } };
    driver.supersedeOnLoad = 2;
    const result = await publication(driver).publishReviewProgress?.({
      change,
      reviewedHeadSha: "head",
      expectedToken: progressToken,
      renderBody: () => progressBody(progressToken),
    });
    expect(result).toEqual({ status: "superseded" });
    expect(driver.writes).toEqual([]);
  });

  it("rechecks the progress lease before every inline write", async () => {
    const driver = new MemoryDriver();
    driver.state = { ...driver.state, main: { id: "main-1", body: progressBody(progressToken) } };
    driver.supersedeOnLoad = 3;
    await expect(
      publication(driver).publish({ change, plan: plan(), progressLease: lease() }),
    ).rejects.toThrow("superseded");
    expect(driver.writes).toEqual(["inline:finding-right"]);
  });

  it("keeps owned progress intact after inline failure", async () => {
    const driver = new MemoryDriver();
    driver.state = { ...driver.state, main: { id: "main-1", body: progressBody(progressToken) } };
    driver.failInline = 1;
    await expect(
      publication(driver).publish({ change, plan: plan(), progressLease: lease() }),
    ).rejects.toBeInstanceOf(PublicationError);
    expect(driver.writes).not.toContain("update-main");
    expect(driver.state.main?.body).toBe(progressBody(progressToken));
  });

  it("publishes main before reporting inline failure without progress", async () => {
    const driver = new MemoryDriver();
    driver.failInline = 1;
    await expect(publication(driver).publish({ change, plan: plan() })).rejects.toMatchObject({
      message: "Memory inline comment publication failed",
      result: {
        inlineComments: { posted: 1, skipped: 0, failed: 1 },
        metadata: {
          inlinePublicationErrors: ["failed finding-right"],
          inlineResolutionErrors: [],
        },
      },
    });
    expect(driver.writes.at(-1)).toBe("create-main");
  });

  it("upserts main, inline, and command comments idempotently", async () => {
    const driver = new MemoryDriver();
    const workflow = publication(driver);
    await expect(workflow.publish({ change, plan: plan() })).resolves.toMatchObject({
      mainComment: { action: "created", id: "main-1" },
      inlineComments: { posted: 2, skipped: 0, failed: 0 },
    });
    await expect(workflow.publish({ change, plan: plan() })).resolves.toMatchObject({
      mainComment: { action: "updated", id: "main-1" },
      inlineComments: { posted: 0, skipped: 2, failed: 0 },
    });
    const command = commandOptions();
    await expect(
      workflow.publishCommandStatus?.({ ...command, state: "accepted", reviewedHeadSha: "head" }),
    ).resolves.toEqual({ action: "created", id: "command-1" });
    await expect(
      workflow.publishCommandStatus?.({ ...command, state: "running", reviewedHeadSha: "head" }),
    ).resolves.toEqual({ action: "updated", id: "command-1" });
    await expect(workflow.publishCommandResponse?.({ ...command, body: "Done." })).resolves.toEqual(
      { action: "updated", id: "command-1" },
    );
  });

  it("preserves successful inline writes across a partial retry", async () => {
    const driver = new MemoryDriver();
    driver.failInline = 1;
    await expect(publication(driver).publish({ change, plan: plan() })).rejects.toMatchObject({
      result: { inlineComments: { posted: 1, failed: 1 } },
    });
    await expect(publication(driver).publish({ change, plan: plan() })).resolves.toMatchObject({
      inlineComments: { posted: 1, skipped: 1, failed: 0 },
    });
  });

  it("does not reserve a location from an unmarked owned comment", async () => {
    const driver = new MemoryDriver();
    const first = plan().inlineItems[0];
    if (!first) throw new Error("expected inline item");
    driver.state = {
      ...driver.state,
      inline: [
        {
          body: "A comment from another workflow using the same owner.",
          location: driver.inlineLocation({ change }, first),
          resolved: false,
        },
      ],
    };

    await expect(publication(driver).publish({ change, plan: plan() })).resolves.toMatchObject({
      inlineComments: { posted: 2, skipped: 0, failed: 0 },
    });
  });

  it("dedupes markers and same-head locations but ignores resolved locations", async () => {
    const driver = new MemoryDriver();
    await publication(driver).publish({ change, plan: plan() });
    await expect(
      publication(driver).publish({ change, plan: plan("-replacement") }),
    ).resolves.toMatchObject({ inlineComments: { posted: 0, skipped: 2 } });
    const first = driver.state.inline[0];
    if (first) first.resolved = true;
    await expect(
      publication(driver).publish({ change, plan: plan("-second") }),
    ).resolves.toMatchObject({ inlineComments: { posted: 1, skipped: 1 } });
  });

  it("allows lifecycle status after head drift but guards the final command response", async () => {
    const driver = new MemoryDriver();
    const workflow = publication(driver);
    const command = commandOptions();
    await workflow.publishCommandStatus?.({
      ...command,
      state: "accepted",
      reviewedHeadSha: "head",
    });
    driver.currentHead = "new-head";
    await expect(
      workflow.publishCommandStatus?.({ ...command, state: "superseded", reviewedHeadSha: "head" }),
    ).resolves.toMatchObject({ action: "updated" });
    await expect(workflow.publishCommandResponse?.({ ...command, body: "Stale." })).rejects.toThrow(
      "head changed",
    );
  });

  it("publishes reply and resolution actions once and escapes nested markers", async () => {
    const driver = new MemoryDriver();
    await publication(driver).publish({ change, plan: plan() });
    const action = threadAction("resolve", "Still applies. <!-- spoof -->");
    const workflow = publication(driver);
    await expect(
      workflow.publishThreadActions?.({ change, actions: [action], reviewedHeadSha: "head" }),
    ).resolves.toEqual({ errors: [] });
    await expect(
      workflow.publishThreadActions?.({ change, actions: [action], reviewedHeadSha: "head" }),
    ).resolves.toEqual({ errors: [] });
    expect(driver.writes.filter((write) => write === "reply:finding-right")).toHaveLength(1);
    expect(driver.writes.filter((write) => write === "resolve:finding-right")).toHaveLength(1);
    const reply = driver.state.threads[0]?.comments.at(-1)?.body;
    expect(reply).toContain("&lt;!-- spoof -->");
  });

  it("matches ID-less thread actions by parent comment", async () => {
    const driver = new MemoryDriver();
    driver.state = {
      ...driver.state,
      threads: [
        {
          findingId: "first",
          findingHeadSha: "head",
          parentCommentId: "first-comment",
          parentBody: "First.",
          threadResolved: false,
          comments: [{ id: "first-comment", body: "First.", authorLogin: "pipr" }],
        },
        {
          findingId: "second",
          findingHeadSha: "head",
          parentCommentId: "second-comment",
          parentBody: "Second.",
          threadResolved: false,
          comments: [{ id: "second-comment", body: "Second.", authorLogin: "pipr" }],
        },
      ],
    };
    const action: ThreadAction = {
      kind: "reply",
      findingId: "second",
      findingHeadSha: "head",
      commentId: "second-comment",
      body: "Still applies.",
      responseKey: "reply:second",
    };
    const options = { change, actions: [action], reviewedHeadSha: "head" };

    await publication(driver).publishThreadActions?.(options);
    await publication(driver).publishThreadActions?.(options);

    expect(driver.writes.filter((write) => write === "reply:second")).toHaveLength(1);
    expect(driver.state.threads[0]?.comments).toHaveLength(1);
    expect(driver.state.threads[1]?.comments).toHaveLength(2);
  });

  it("does not reply to a thread that is already resolved", async () => {
    const driver = new MemoryDriver();
    await publication(driver).publish({ change, plan: plan() });
    const thread = driver.state.threads[0];
    if (!thread) throw new Error("expected inline thread");
    thread.threadResolved = true;

    await expect(
      publication(driver).publishThreadActions?.({
        change,
        actions: [threadAction("resolve")],
        reviewedHeadSha: "head",
      }),
    ).resolves.toEqual({ errors: [] });
    expect(driver.writes).not.toContain("reply:finding-right");
    expect(driver.writes).not.toContain("resolve:finding-right");
  });

  it("ignores foreign reply markers and rechecks head before thread writes", async () => {
    const driver = new MemoryDriver();
    await publication(driver).publish({ change, plan: plan() });
    const action = threadAction("reply");
    const marker = renderVerifierResponseMarker(action.findingId, action.responseKey);
    const thread = driver.state.threads[0];
    thread?.comments.push({ id: "foreign", body: marker, authorLogin: "someone-else" });
    // Drivers project only Pipr-owned replies through LoadedPublicationState.
    if (thread)
      thread.comments = thread.comments.filter((comment) => comment.authorLogin !== "someone-else");
    driver.changeHeadOnLoad = driver.loadCount + 1;
    await expect(
      publication(driver).publishThreadActions?.({
        change,
        actions: [action],
        reviewedHeadSha: "head",
      }),
    ).rejects.toThrow("head changed");
    expect(driver.writes).not.toContain("reply:finding-right");
  });
});

function publication(driver: MemoryDriver) {
  return createPublicationWorkflow(driver);
}

function progressBody(token: string): string {
  return [
    `<!-- pipr:main-comment change=${change.change.number} version=1 -->`,
    `<!-- pipr:progress:start token=${token} head=head stage=preparing-workspace state=running -->`,
    "Progress",
    "<!-- pipr:progress:end -->",
  ].join("\n");
}

function lease(): ReviewProgressLease {
  return {
    token: progressToken,
    mainCommentId: "main-1",
    mainCommentAction: "created",
    reviewedHeadSha: "head",
  };
}

function plan(suffix = "") {
  const inlineItems = [
    inlineItem(`finding-right${suffix}`, "src/new.ts", "RIGHT", 2),
    inlineItem(`finding-left${suffix}`, "src/old.ts", "LEFT", 6),
  ];
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems,
    reviewState: {
      version: 1,
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      findings: inlineItems.map((item) => ({
        id: item.findingId,
        status: "open" as const,
        path: item.path,
        rangeId: item.finding.rangeId,
        side: item.side,
        startLine: item.startLine,
        endLine: item.endLine,
        firstSeenHeadSha: "head",
        lastSeenHeadSha: "head",
      })),
    },
    metadata: {
      runtimeVersion,
      reviewedHeadSha: "head",
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: 2,
      droppedFindings: 0,
    },
  });
}

function inlineItem(
  findingId: string,
  path: string,
  side: "LEFT" | "RIGHT",
  line: number,
): InlinePublicationItem {
  const finding = {
    body: "Fix this.",
    path,
    rangeId: `range-${findingId}`,
    side,
    startLine: line,
    endLine: line,
  };
  return {
    finding,
    range: {
      id: finding.rangeId,
      path,
      side,
      startLine: line,
      endLine: line,
      kind: side === "RIGHT" ? "added" : "deleted",
      hunkIndex: 1,
      hunkHeader: "@@ -1,8 +1,8 @@",
      hunkContentHash: "deadbeefcafe",
    },
    path,
    previousPath: side === "LEFT" ? "src/old.ts" : undefined,
    side,
    startLine: line,
    endLine: line,
    body: `${renderInlineFindingMarker(findingId, "head")}\nFix this.`,
    marker: `pipr:finding:${findingId}:head`,
    findingId,
    reviewedHeadSha: "head",
  };
}

function commandOptions() {
  return { change, sourceCommentId: "101", commandName: "review" };
}

function threadAction(kind: ThreadAction["kind"], body = "Still applies."): ThreadAction {
  return {
    kind,
    findingId: "finding-right",
    findingHeadSha: "head",
    commentId: "finding-right",
    threadId: "thread:finding-right",
    body,
    responseKey: `${kind}:finding-right`,
  };
}
