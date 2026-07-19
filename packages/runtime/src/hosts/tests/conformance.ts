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
import type { ChangeRequestEventContext } from "../../types.js";
import type {
  CodeHostAdapter,
  CodeHostEvent,
  CodeHostStatusState,
  RepositoryPermission,
} from "../types.js";

export type ConformanceEvents = {
  changeRequest: CodeHostEvent;
  command: CodeHostEvent;
  reply: CodeHostEvent;
  draft: CodeHostEvent;
};

export type ObservedInlineAnchor = {
  path: string;
  previousPath?: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
  headSha: string;
};

export type ObservedWrites = {
  mainCreates: number;
  mainUpdates: number;
  inlineCreates: number;
  commandCreates: number;
  commandUpdates: number;
  replies: number;
  resolutions: number;
};

export type ObservedStatus = {
  name: string;
  state: CodeHostStatusState;
  summary?: string;
  headSha: string;
};

export type CodeHostAdapterConformanceHarness = {
  adapter: CodeHostAdapter;
  change: ChangeRequestEventContext;
  events(): Promise<ConformanceEvents>;
  setPermission(permission: RepositoryPermission): void;
  permissionRequests(): Array<{ actor: string }>;
  setCurrentHead(headSha: string): void;
  advanceHeadDuringPreflight(): void;
  failNextInline(): void;
  seedForeignInline(): void;
  seedForeignReply(body: string): void;
  setFirstInlineResolved(resolved: boolean): void;
  ownedReplyBodies(): string[];
  writes(): ObservedWrites;
  anchors(): ObservedInlineAnchor[];
  statuses(): ObservedStatus[];
  dispose?(): Promise<void>;
};

export function defineCodeHostAdapterConformanceSuite(options: {
  name: string;
  createHarness(): Promise<CodeHostAdapterConformanceHarness> | CodeHostAdapterConformanceHarness;
}): void {
  describe(`${options.name} code host adapter conformance`, () => {
    it("normalizes change, command, and reply events", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const events = await harness.events();
        expect(events.changeRequest).toMatchObject({
          kind: "change-request",
          change: {
            action: "opened",
            platform: { id: harness.adapter.id },
            repository: { slug: harness.change.repository.slug },
            change: {
              number: harness.change.change.number,
              base: { sha: harness.change.change.base.sha },
              head: { sha: harness.change.change.head.sha },
            },
          },
        });
        expect(events.command).toMatchObject({
          kind: "command-comment",
          comment: {
            changeNumber: harness.change.change.number,
            commentId: expect.any(String),
            body: "@pipr review",
            actor: "developer",
          },
        });
        expect(events.reply).toMatchObject({
          kind: "review-comment-reply",
          reply: {
            changeNumber: harness.change.change.number,
            commentId: expect.any(String),
            parentCommentId: expect.any(String),
            body: "Fixed.",
            actor: "developer",
          },
        });
        expect(events.draft).toEqual({ kind: "ignored", reason: expect.any(String) });
      });
    });

    it("normalizes repository permissions through the adapter seam", async () => {
      await withHarness(options.createHarness, async (harness) => {
        harness.setPermission("write");
        await expect(
          harness.adapter.permissions.getRepositoryPermission({
            change: harness.change,
            actor: "developer",
          }),
        ).resolves.toBe("write");
        harness.setPermission("none");
        await expect(
          harness.adapter.permissions.getRepositoryPermission({
            change: harness.change,
            actor: "outsider",
          }),
        ).resolves.toBe("none");
        expect(harness.permissionRequests()).toEqual([
          { actor: "developer" },
          { actor: "outsider" },
        ]);
      });
    });

    it("rejects a stale head before publication writes", async () => {
      await withHarness(options.createHarness, async (harness) => {
        harness.setCurrentHead("new-head");
        await expectStaleWithoutWrites(harness, () =>
          requiredPublication(harness.adapter).publish({
            change: harness.change,
            plan: publicationPlan(harness.change),
          }),
        );
      });
    });

    it("rechecks the head after preflight reads and before the first write", async () => {
      await withHarness(options.createHarness, async (harness) => {
        harness.advanceHeadDuringPreflight();
        await expectStaleWithoutWrites(harness, () =>
          requiredPublication(harness.adapter).publish({
            change: harness.change,
            plan: publicationPlan(harness.change),
          }),
        );
      });
    });

    it("rechecks the head before a command response write", async () => {
      await withHarness(options.createHarness, async (harness) => {
        harness.advanceHeadDuringPreflight();
        const publishCommandResponse = requiredMethod(
          requiredPublication(harness.adapter).publishCommandResponse,
          "command response publication",
        );
        await expect(
          publishCommandResponse({
            change: harness.change,
            sourceCommentId: "101",
            commandName: "review",
            body: "Queued.",
          }),
        ).rejects.toThrow(/head changed|endpoints changed/i);
        expect(harness.writes()).toEqual(zeroWrites());
      });
    });

    it("reuses one command comment while lifecycle statuses bypass stale-head guards", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const publication = requiredPublication(harness.adapter);
        const publishCommandStatus = requiredMethod(
          publication.publishCommandStatus,
          "command status publication",
        );
        const command = {
          change: harness.change,
          sourceCommentId: "101",
          commandName: "review",
          reviewedHeadSha: harness.change.change.head.sha,
        };

        await expect(
          publishCommandStatus({ ...command, state: "accepted" }),
        ).resolves.toMatchObject({ action: "created" });
        await expect(publishCommandStatus({ ...command, state: "running" })).resolves.toMatchObject(
          { action: "updated" },
        );
        await expect(
          requiredMethod(
            publication.publishCommandResponse,
            "command response publication",
          )({
            change: harness.change,
            sourceCommentId: command.sourceCommentId,
            commandName: command.commandName,
            body: "Completed response.",
          }),
        ).resolves.toMatchObject({ action: "updated" });
        expect(harness.writes()).toMatchObject({ commandCreates: 1, commandUpdates: 2 });

        harness.setCurrentHead("new-head");
        await expect(
          publishCommandStatus({
            ...command,
            state: "superseded",
            currentHeadSha: "new-head",
          }),
        ).resolves.toMatchObject({ action: "updated" });
        await expect(
          requiredMethod(
            publication.publishCommandResponse,
            "command response publication",
          )({
            change: harness.change,
            sourceCommentId: command.sourceCommentId,
            commandName: command.commandName,
            body: "Stale response.",
          }),
        ).rejects.toThrow(/head changed|endpoints changed/i);
      });
    });

    it("keeps older lifecycle states from overwriting a newer command attempt", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const publication = requiredPublication(harness.adapter);
        const publishCommandStatus = requiredMethod(
          publication.publishCommandStatus,
          "command status publication",
        );
        const publishCommandResponse = requiredMethod(
          publication.publishCommandResponse,
          "command response publication",
        );
        const originalCommand = {
          change: harness.change,
          sourceCommentId: "101",
          commandName: "review",
          reviewedHeadSha: harness.change.change.head.sha,
        };

        await expect(
          publishCommandStatus({ ...originalCommand, state: "accepted" }),
        ).resolves.toMatchObject({ action: "created" });

        const currentHeadSha = "new-head";
        harness.setCurrentHead(currentHeadSha);
        const currentChange = {
          ...harness.change,
          change: {
            ...harness.change.change,
            head: { ...harness.change.change.head, sha: currentHeadSha },
          },
        } satisfies ChangeRequestEventContext;
        const currentCommand = {
          ...originalCommand,
          change: currentChange,
          reviewedHeadSha: currentHeadSha,
        };
        const publishOlderStatuses = async () => {
          for (const status of [
            { state: "running" as const },
            { state: "completed" as const },
            { state: "failed" as const },
            { state: "superseded" as const, currentHeadSha },
          ]) {
            await expect(
              publishCommandStatus({ ...originalCommand, ...status }),
            ).resolves.toMatchObject({ action: "updated" });
          }
        };
        await expect(
          publishCommandStatus({ ...currentCommand, state: "accepted" }),
        ).resolves.toMatchObject({ action: "updated" });
        await expect(
          publishCommandStatus({ ...currentCommand, state: "running" }),
        ).resolves.toMatchObject({ action: "updated" });

        await publishOlderStatuses();
        expect(harness.writes()).toMatchObject({ commandCreates: 1, commandUpdates: 2 });

        await expect(
          publishCommandResponse({
            change: currentChange,
            sourceCommentId: currentCommand.sourceCommentId,
            commandName: currentCommand.commandName,
            body: "Current response.",
          }),
        ).resolves.toMatchObject({ action: "updated" });
        await publishOlderStatuses();
        expect(harness.writes()).toMatchObject({ commandCreates: 1, commandUpdates: 3 });
      });
    });

    it("upserts main, inline, and command comments idempotently", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const publication = requiredPublication(harness.adapter);
        const plan = publicationPlan(harness.change);
        await expect(publication.publish({ change: harness.change, plan })).resolves.toMatchObject({
          mainComment: { action: "created" },
          inlineComments: { posted: 2, skipped: 0, failed: 0 },
        });
        await expect(publication.publish({ change: harness.change, plan })).resolves.toMatchObject({
          mainComment: { action: "updated" },
          inlineComments: { posted: 0, skipped: 2, failed: 0 },
        });

        const publishCommandResponse = requiredMethod(
          publication.publishCommandResponse,
          "command response publication",
        );
        const command = {
          change: harness.change,
          sourceCommentId: "101",
          commandName: "review",
          body: "Queued.",
        };
        await expect(publishCommandResponse(command)).resolves.toMatchObject({ action: "created" });
        await expect(
          publishCommandResponse({ ...command, body: "Updated." }),
        ).resolves.toMatchObject({ action: "updated" });

        expect(harness.writes()).toMatchObject({
          mainCreates: 1,
          mainUpdates: 1,
          inlineCreates: 2,
          commandCreates: 1,
          commandUpdates: 1,
        });
      });
    });

    it("preserves successful inline writes across a partial retry", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const publication = requiredPublication(harness.adapter);
        const plan = publicationPlan(harness.change);
        harness.failNextInline();
        await expect(publication.publish({ change: harness.change, plan })).rejects.toMatchObject({
          result: { inlineComments: { posted: 1, failed: 1 } },
        });
        await expect(publication.publish({ change: harness.change, plan })).resolves.toMatchObject({
          inlineComments: { posted: 1, skipped: 1, failed: 0 },
        });
        expect(harness.writes().inlineCreates).toBe(2);
      });
    });

    it("dedupes overlapping same-head anchors when finding IDs change", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const publication = requiredPublication(harness.adapter);
        await publication.publish({
          change: harness.change,
          plan: publicationPlan(harness.change),
        });
        await expect(
          publication.publish({
            change: harness.change,
            plan: publicationPlan(harness.change, "-replacement"),
          }),
        ).resolves.toMatchObject({ inlineComments: { posted: 0, skipped: 2, failed: 0 } });
        expect(harness.writes().inlineCreates).toBe(2);
      });
    });

    it("does not dedupe an inline anchor owned by another actor", async () => {
      await withHarness(options.createHarness, async (harness) => {
        harness.seedForeignInline();
        await expect(
          requiredPublication(harness.adapter).publish({
            change: harness.change,
            plan: publicationPlan(harness.change),
          }),
        ).resolves.toMatchObject({ inlineComments: { posted: 2, skipped: 0, failed: 0 } });
        expect(harness.writes().inlineCreates).toBe(2);
      });
    });

    it("maps right and renamed left multiline anchors", async () => {
      await withHarness(options.createHarness, async (harness) => {
        await requiredPublication(harness.adapter).publish({
          change: harness.change,
          plan: publicationPlan(harness.change),
        });
        expect(harness.anchors()).toEqual([
          {
            path: "src/new.ts",
            side: "RIGHT",
            startLine: 2,
            endLine: 4,
            headSha: "head",
          },
          {
            path: "src/new.ts",
            previousPath: "src/old.ts",
            side: "LEFT",
            startLine: 6,
            endLine: 7,
            headSha: "head",
          },
        ]);
      });
    });

    it("publishes replies and resolutions once", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const { publication, context } = await publishAndLoadFirstInlineContext(harness);
        const publishThreadActions = requiredMethod(
          publication.publishThreadActions,
          "thread action publication",
        );
        const reply = threadAction("reply", context);
        await expectThreadActionTwice(publishThreadActions, harness.change, reply);
        expect(harness.writes()).toMatchObject({ replies: 1, resolutions: 0 });

        const resolve = threadAction("resolve", context);
        await expectThreadActionTwice(publishThreadActions, harness.change, resolve);
        expect(harness.writes()).toMatchObject({ replies: 2, resolutions: 1 });
        const resolvedContexts = await requiredComments(harness.adapter).loadInlineThreadContexts?.(
          { change: harness.change },
        );
        expect(
          resolvedContexts?.find((item) => item.findingId === context.findingId),
        ).toMatchObject({ threadResolved: true });
      });
    });

    it("loads native inline resolution into prior review state", async () => {
      await withHarness(options.createHarness, async (harness) => {
        await requiredPublication(harness.adapter).publish({
          change: harness.change,
          plan: publicationPlan(harness.change),
        });
        const loadPriorReviewState = requiredMethod(
          harness.adapter.comments?.loadPriorReviewState,
          "prior review state loading",
        );

        harness.setFirstInlineResolved(true);
        await expect(loadPriorReviewState({ change: harness.change })).resolves.toMatchObject({
          findings: [expect.objectContaining({ status: "resolved" }), expect.anything()],
        });

        harness.setFirstInlineResolved(false);
        await expect(loadPriorReviewState({ change: harness.change })).resolves.toMatchObject({
          findings: [expect.objectContaining({ status: "open" }), expect.anything()],
        });
      });
    });

    it("ignores foreign reply markers and escapes nested markers in bot replies", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const { publication, context } = await publishAndLoadFirstInlineContext(harness);
        const publishThreadActions = requiredMethod(
          publication.publishThreadActions,
          "thread action publication",
        );
        const action = threadAction("reply", context, "Still applies. <!-- spoof -->");
        harness.seedForeignReply(
          renderVerifierResponseMarker(action.findingId, action.responseKey),
        );

        await expectThreadActionTwice(publishThreadActions, harness.change, action);

        expect(harness.writes().replies).toBe(1);
        expect(harness.ownedReplyBodies()).toEqual([
          [
            renderVerifierResponseMarker(action.findingId, action.responseKey),
            "",
            "Still applies. &lt;!-- spoof -->",
          ].join("\n"),
        ]);
      });
    });

    it("rechecks the head before a thread action write", async () => {
      await withHarness(options.createHarness, async (harness) => {
        const { publication, context } = await publishAndLoadFirstInlineContext(harness);
        const before = harness.writes();
        harness.advanceHeadDuringPreflight();
        const publishThreadActions = requiredMethod(
          publication.publishThreadActions,
          "thread action publication",
        );
        await expect(
          publishThreadActions({
            change: harness.change,
            actions: [threadAction("resolve", context)],
            reviewedHeadSha: "head",
          }),
        ).rejects.toThrow(/head changed|endpoints changed/i);
        expect(harness.writes()).toEqual(before);
      });
    });

    for (const conclusion of ["success", "failure", "neutral"] as const) {
      it(`transitions a status from pending to ${conclusion}`, async () => {
        await withHarness(options.createHarness, async (harness) => {
          const statuses = requiredStatuses(harness.adapter);
          expect(statuses.isAvailable(harness.change)).toBe(true);
          const status = await statuses.upsert({
            change: harness.change,
            name: "review",
            state: "pending",
            summary: "Running.",
          });
          await expect(
            statuses.upsert({
              change: harness.change,
              name: "review",
              state: conclusion,
              summary: "Done.",
              status,
            }),
          ).resolves.toEqual(status);
          expect(harness.statuses()).toEqual([
            { name: "review", state: "pending", summary: "Running.", headSha: "head" },
            { name: "review", state: conclusion, summary: "Done.", headSha: "head" },
          ]);
        });
      });
    }
  });
}

async function expectStaleWithoutWrites(
  harness: CodeHostAdapterConformanceHarness,
  publish: () => Promise<unknown>,
): Promise<void> {
  await expect(publish()).rejects.toThrow(/head changed|endpoints changed/i);
  expect(harness.writes()).toEqual(zeroWrites());
}

async function publishAndLoadFirstInlineContext(harness: CodeHostAdapterConformanceHarness) {
  const publication = requiredPublication(harness.adapter);
  await publication.publish({
    change: harness.change,
    plan: publicationPlan(harness.change),
  });
  const contexts = await requiredComments(harness.adapter).loadInlineThreadContexts?.({
    change: harness.change,
  });
  const context = contexts?.[0];
  if (!context) throw new Error("Conformance harness did not publish an inline thread");
  return { publication, context };
}

async function expectThreadActionTwice(
  publish: NonNullable<ReturnType<typeof requiredPublication>["publishThreadActions"]>,
  change: ChangeRequestEventContext,
  action: ThreadAction,
): Promise<void> {
  const options = { change, actions: [action], reviewedHeadSha: "head" };
  await expect(publish(options)).resolves.toEqual({ errors: [] });
  await expect(publish(options)).resolves.toEqual({ errors: [] });
}

function publicationPlan(change: ChangeRequestEventContext, findingSuffix = "") {
  const items = [
    inlineItem({
      id: `finding-right${findingSuffix}`,
      path: "src/new.ts",
      side: "RIGHT",
      startLine: 2,
      endLine: 4,
    }),
    inlineItem({
      id: `finding-left${findingSuffix}`,
      path: "src/new.ts",
      previousPath: "src/old.ts",
      side: "LEFT",
      startLine: 6,
      endLine: 7,
    }),
  ];
  return buildPublicationPlan({
    event: change,
    main: "Summary.",
    inlineItems: items,
    reviewState: {
      version: 1,
      reviewedHeadSha: change.change.head.sha,
      selectedTasks: ["review"],
      findings: items.map((item) => ({
        id: item.findingId,
        status: "open",
        path: item.path,
        rangeId: item.finding.rangeId,
        side: item.side,
        startLine: item.startLine,
        endLine: item.endLine,
        firstSeenHeadSha: change.change.head.sha,
        lastSeenHeadSha: change.change.head.sha,
      })),
    },
    metadata: {
      runtimeVersion,
      reviewedHeadSha: change.change.head.sha,
      selectedTasks: ["review"],
      failedTasks: [],
      validFindings: items.length,
      droppedFindings: 0,
    },
  });
}

function inlineItem(options: {
  id: string;
  path: string;
  previousPath?: string;
  side: "LEFT" | "RIGHT";
  startLine: number;
  endLine: number;
}): InlinePublicationItem {
  const finding = {
    body: "Fix this.",
    path: options.path,
    rangeId: `range-${options.id}`,
    side: options.side,
    startLine: options.startLine,
    endLine: options.endLine,
  };
  return {
    finding,
    range: {
      id: finding.rangeId,
      path: options.path,
      side: options.side,
      startLine: options.startLine,
      endLine: options.endLine,
      kind: options.side === "RIGHT" ? "added" : "deleted",
      hunkIndex: 1,
      hunkHeader: "@@ -1,8 +1,8 @@",
      hunkContentHash: "deadbeefcafe",
    },
    path: options.path,
    previousPath: options.previousPath,
    side: options.side,
    startLine: options.startLine,
    endLine: options.endLine,
    body: `${renderInlineFindingMarker(options.id, "head")}\nFix this.`,
    marker: `pipr:finding:${options.id}:head`,
    findingId: options.id,
    reviewedHeadSha: "head",
  };
}

function threadAction(
  kind: ThreadAction["kind"],
  context: {
    findingId: string;
    findingHeadSha: string;
    parentCommentId: string;
    threadId?: string;
  },
  body = kind === "resolve" ? "Resolved." : "Still applies.",
): ThreadAction {
  return {
    kind,
    findingId: context.findingId,
    findingHeadSha: context.findingHeadSha,
    commentId: context.parentCommentId,
    threadId: context.threadId,
    body,
    responseKey: `${kind}:${context.findingId}`,
  };
}

async function withHarness(
  createHarness: () =>
    | Promise<CodeHostAdapterConformanceHarness>
    | CodeHostAdapterConformanceHarness,
  run: (harness: CodeHostAdapterConformanceHarness) => Promise<void>,
): Promise<void> {
  const harness = await createHarness();
  try {
    await run(harness);
  } finally {
    await harness.dispose?.();
  }
}

function requiredPublication(adapter: CodeHostAdapter) {
  if (!adapter.publication) throw new Error(`${adapter.id} publication is required`);
  return adapter.publication;
}

function requiredComments(adapter: CodeHostAdapter) {
  if (!adapter.comments?.loadInlineThreadContexts) {
    throw new Error(`${adapter.id} inline thread loading is required`);
  }
  return adapter.comments;
}

function requiredStatuses(adapter: CodeHostAdapter) {
  if (!adapter.statuses) throw new Error(`${adapter.id} statuses are required`);
  return adapter.statuses;
}

function requiredMethod<T>(method: T | undefined, name: string): T {
  if (!method) throw new Error(`${name} is required`);
  return method;
}

function zeroWrites(): ObservedWrites {
  return {
    mainCreates: 0,
    mainUpdates: 0,
    inlineCreates: 0,
    commandCreates: 0,
    commandUpdates: 0,
    replies: 0,
    resolutions: 0,
  };
}
