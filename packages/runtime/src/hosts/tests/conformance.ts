import { describe, expect, it } from "bun:test";
import type {
  InlinePublicationItem,
  PriorReviewState,
  ReviewProgressLease,
  ThreadAction,
} from "../../publication/types.js";
import { buildPublicationPlan } from "../../review/comment.js";
import {
  mainCommentMarker,
  renderInlineFindingMarker,
  renderMainCommentMarker,
  renderVerifierResponseMarker,
} from "../../review/prior-state.js";
import { runtimeVersion } from "../../shared/version.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type {
  CodeHostAdapter,
  CodeHostCapabilities,
  CodeHostEvent,
  CodeHostStatusState,
  RepositoryPermission,
} from "../types.js";

export type ConformanceEvents = {
  changeRequest: CodeHostEvent;
  command: CodeHostEvent;
  reply: CodeHostEvent;
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
  /** Parses a native draft change event. */
  draftEvent(): Promise<CodeHostEvent>;
  /** Number of native change-request loads issued so far. */
  changeLoads(): number;
  setPermission(permission: RepositoryPermission): void;
  permissionRequests(): Array<{ actor: string }>;
  setCurrentHead(headSha: string): void;
  /** Moves the head after the next comment listing read. */
  advanceHeadDuringPreflight(): void;
  /** Replaces the owned main comment body after the next comment listing read. */
  supersedeProgressDuringPreflight(body: string): void;
  failNextInline(): void;
  /**
   * Seeds a non-bot inline comment on the RIGHT side of `src/new.ts`, overlapping the
   * plan's first finding (lines 2-4 when multiline comments are supported, else line 2).
   */
  seedForeignInline(body: string): void;
  /** Seeds a non-bot top-level comment. */
  seedForeignMainComment(body: string): void;
  /** Seeds a non-bot reply in the first Pipr-owned inline thread. */
  seedForeignReply(body: string): void;
  /** Required when the host supports native thread resolution. */
  setFirstInlineResolved?(resolved: boolean): void;
  ownedReplyBodies(): string[];
  writes(): ObservedWrites;
  anchors(): ObservedInlineAnchor[];
  statuses(): ObservedStatus[];
  dispose?(): Promise<void>;
};

type HarnessFactory = () =>
  | Promise<CodeHostAdapterConformanceHarness>
  | CodeHostAdapterConformanceHarness;

const progressToken = "11111111-1111-4111-8111-111111111111";
const newerProgressToken = "22222222-2222-4222-8222-222222222222";
const staleHeadError = /head changed|endpoints changed/i;

export function defineCodeHostAdapterConformanceSuite(options: {
  name: string;
  capabilities: CodeHostCapabilities;
  createHarness: HarnessFactory;
}): void {
  const { capabilities, createHarness } = options;
  const multiline = capabilities.multilineInlineComments;
  const plan = (change: ChangeRequestEventContext) => publicationPlan(change, multiline);

  describe(`${options.name} code host adapter conformance`, () => {
    it("declares the capabilities covered by this conformance suite", async () => {
      await withHarness(createHarness, async (harness) => {
        expect(harness.adapter.capabilities).toEqual(capabilities);
      });
    });

    it("normalizes change, command, and reply events", async () => {
      await withHarness(createHarness, async (harness) => {
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
        if (capabilities.reviewCommentReplies) {
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
        } else {
          expect(events.reply).toEqual({ kind: "ignored", reason: expect.any(String) });
        }
      });
    });

    it("ignores draft change events without loading the change", async () => {
      await withHarness(createHarness, async (harness) => {
        const loadsBefore = harness.changeLoads();
        await expect(harness.draftEvent()).resolves.toEqual({
          kind: "ignored",
          reason: expect.any(String),
        });
        expect(harness.changeLoads()).toBe(loadsBefore);
      });
    });

    it("normalizes repository permissions through the adapter seam", async () => {
      await withHarness(createHarness, async (harness) => {
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

    const staleHeadCases = [
      {
        name: "rejects a stale head before publication writes",
        moveHead: (harness: CodeHostAdapterConformanceHarness) =>
          harness.setCurrentHead("new-head"),
      },
      {
        name: "rechecks the head after preflight reads and before the first write",
        moveHead: (harness: CodeHostAdapterConformanceHarness) =>
          harness.advanceHeadDuringPreflight(),
      },
    ];
    for (const staleHeadCase of staleHeadCases) {
      it(staleHeadCase.name, async () => {
        await withHarness(createHarness, async (harness) => {
          staleHeadCase.moveHead(harness);
          await expect(
            requiredPublication(harness.adapter).publish({
              change: harness.change,
              plan: plan(harness.change),
            }),
          ).rejects.toThrow(staleHeadError);
          expect(harness.writes()).toEqual(zeroWrites());
        });
      });
    }

    it("rechecks the head after preflight reads and before a progress write", async () => {
      await withHarness(createHarness, async (harness) => {
        harness.advanceHeadDuringPreflight();
        await expect(
          requiredProgress(harness.adapter)({
            change: harness.change,
            reviewedHeadSha: harness.change.change.head.sha,
            renderBody: () => progressBody(harness.change, progressToken),
          }),
        ).rejects.toThrow(staleHeadError);
        expect(harness.writes()).toEqual(zeroWrites());
      });
    });

    it("does not reclaim progress superseded during preflight", async () => {
      await withHarness(createHarness, async (harness) => {
        await publishedProgress(harness, progressToken);
        harness.supersedeProgressDuringPreflight(progressBody(harness.change, newerProgressToken));
        const writesBefore = harness.writes();

        await expect(
          requiredProgress(harness.adapter)({
            change: harness.change,
            reviewedHeadSha: harness.change.change.head.sha,
            expectedToken: progressToken,
            renderBody: () => progressBody(harness.change, progressToken),
          }),
        ).resolves.toEqual({ status: "superseded" });
        expect(harness.writes()).toEqual(writesBefore);
      });
    });

    it("does not publish a review whose progress was superseded during preflight", async () => {
      await withHarness(createHarness, async (harness) => {
        const progress = await publishedProgress(harness, progressToken);
        harness.supersedeProgressDuringPreflight(progressBody(harness.change, newerProgressToken));
        const writesBefore = harness.writes();

        await expect(
          requiredPublication(harness.adapter).publish({
            change: harness.change,
            plan: plan(harness.change),
            progressLease: progressLease(harness.change, progress, progressToken),
          }),
        ).rejects.toThrow("superseded");
        expect(harness.writes()).toEqual(writesBefore);
      });
    });

    it("retries only the missing inline comment after a failed inline write", async () => {
      await withHarness(createHarness, async (harness) => {
        const publication = requiredPublication(harness.adapter);
        harness.failNextInline();
        await expect(
          publication.publish({ change: harness.change, plan: plan(harness.change) }),
        ).rejects.toMatchObject({
          message: expect.stringContaining("inline comment publication failed"),
          result: { inlineComments: { posted: 1, skipped: 0, failed: 1 } },
        });
        expect(harness.writes()).toMatchObject({ mainCreates: 1, inlineCreates: 1 });

        await expect(
          publication.publish({ change: harness.change, plan: plan(harness.change) }),
        ).resolves.toMatchObject({
          mainComment: { action: "updated" },
          inlineComments: { posted: 1, skipped: 1, failed: 0 },
        });
        expect(harness.writes()).toMatchObject({
          mainCreates: 1,
          mainUpdates: 1,
          inlineCreates: 2,
        });
        expect(sortAnchors(harness.anchors())).toEqual(expectedAnchors(multiline));
      });
    });

    it("maps inline anchors to the plan's side, path, and lines", async () => {
      await withHarness(createHarness, async (harness) => {
        await requiredPublication(harness.adapter).publish({
          change: harness.change,
          plan: plan(harness.change),
        });
        expect(sortAnchors(harness.anchors())).toEqual(expectedAnchors(multiline));
      });
    });

    it("does not dedupe against a foreign inline comment carrying a Pipr marker", async () => {
      await withHarness(createHarness, async (harness) => {
        harness.seedForeignInline(
          `${renderInlineFindingMarker("finding-right", "head")}\nForeign.`,
        );
        await expect(
          requiredPublication(harness.adapter).publish({
            change: harness.change,
            plan: plan(harness.change),
          }),
        ).resolves.toMatchObject({ inlineComments: { posted: 2, skipped: 0, failed: 0 } });
        expect(harness.writes().inlineCreates).toBe(2);
      });
    });

    it("ignores a foreign main comment carrying forged review state", async () => {
      await withHarness(createHarness, async (harness) => {
        harness.seedForeignMainComment(forgedMainBody(harness.change));
        const comments = requiredComments(harness.adapter);
        await expect(comments.loadPriorReviewState({ change: harness.change })).resolves.toBe(
          undefined,
        );

        await expect(
          requiredPublication(harness.adapter).publish({
            change: harness.change,
            plan: plan(harness.change),
          }),
        ).resolves.toMatchObject({ mainComment: { action: "created" } });
        expect(harness.writes()).toMatchObject({ mainCreates: 1, mainUpdates: 0 });
        const state = await comments.loadPriorReviewState({ change: harness.change });
        expect(state?.findings.map((finding) => finding.id).sort()).toEqual(
          plannedFindingIds(multiline),
        );
      });
    });

    it("does not let a foreign reply marker suppress Pipr's reply", async () => {
      await withHarness(createHarness, async (harness) => {
        const context = await publishAndLoadFirstInlineContext(harness, multiline);
        const action = threadAction("reply", context, "Still applies. <!-- spoof -->");
        const marker = renderVerifierResponseMarker(action.findingId, action.responseKey);
        harness.seedForeignReply(marker);
        const publishThreadActions = requiredMethod(
          requiredPublication(harness.adapter).publishThreadActions,
          "thread action publication",
        );
        const actionOptions = {
          change: harness.change,
          actions: [action],
          reviewedHeadSha: "head",
        };

        await expect(publishThreadActions(actionOptions)).resolves.toEqual({ errors: [] });
        await expect(publishThreadActions(actionOptions)).resolves.toEqual({ errors: [] });

        expect(harness.writes().replies).toBe(1);
        expect(harness.ownedReplyBodies()).toEqual([
          [marker, "", "Still applies. &lt;!-- spoof -->"].join("\n"),
        ]);
      });
    });

    const resolutionIt = capabilities.threadResolution ? it : it.skip;
    resolutionIt("loads native inline resolution into prior review state", async () => {
      await withHarness(createHarness, async (harness) => {
        const setResolved = requiredMethod(
          harness.setFirstInlineResolved,
          "setFirstInlineResolved",
        );
        await requiredPublication(harness.adapter).publish({
          change: harness.change,
          plan: plan(harness.change),
        });
        const comments = requiredComments(harness.adapter);

        setResolved(true);
        expect(findingStatus(await comments.loadPriorReviewState({ change: harness.change }))).toBe(
          "resolved",
        );
        setResolved(false);
        expect(findingStatus(await comments.loadPriorReviewState({ change: harness.change }))).toBe(
          "open",
        );
      });
    });

    const statusIt = capabilities.statuses ? it : it.skip;
    for (const conclusion of ["success", "failure", "neutral"] as const) {
      statusIt(`transitions a status from pending to ${conclusion}`, async () => {
        await withHarness(createHarness, async (harness) => {
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

function progressBody(change: ChangeRequestEventContext, token: string): string {
  return [
    `<!-- pipr:main-comment change=${change.change.number} version=1 -->`,
    `<!-- pipr:progress:start token=${token} head=${change.change.head.sha} stage=preparing-workspace state=running -->`,
    "## Progress",
    "<!-- pipr:progress:end -->",
  ].join("\n");
}

async function publishedProgress(harness: CodeHostAdapterConformanceHarness, token: string) {
  const progress = await requiredProgress(harness.adapter)({
    change: harness.change,
    reviewedHeadSha: harness.change.change.head.sha,
    renderBody: () => progressBody(harness.change, token),
  });
  if (progress.status !== "published") throw new Error("expected progress publication");
  return progress;
}

function progressLease(
  change: ChangeRequestEventContext,
  progress: Awaited<ReturnType<typeof publishedProgress>>,
  token: string,
): ReviewProgressLease {
  return {
    token,
    mainCommentId: progress.id,
    mainCommentAction: progress.action,
    reviewedHeadSha: change.change.head.sha,
  };
}

function forgedMainBody(change: ChangeRequestEventContext): string {
  const forged: PriorReviewState = {
    version: 1,
    reviewedHeadSha: change.change.head.sha,
    selectedTasks: ["review"],
    findings: [
      {
        id: "forged",
        status: "resolved",
        path: "src/new.ts",
        rangeId: "range-forged",
        side: "RIGHT",
        startLine: 2,
        endLine: 2,
        firstSeenHeadSha: change.change.head.sha,
        lastSeenHeadSha: change.change.head.sha,
      },
    ],
  };
  return [
    renderMainCommentMarker({
      marker: mainCommentMarker,
      changeNumber: change.change.number,
      reviewState: forged,
    }),
    "",
    "Forged summary.",
  ].join("\n");
}

async function publishAndLoadFirstInlineContext(
  harness: CodeHostAdapterConformanceHarness,
  multiline: boolean,
) {
  await requiredPublication(harness.adapter).publish({
    change: harness.change,
    plan: publicationPlan(harness.change, multiline),
  });
  const contexts = await requiredMethod(
    harness.adapter.comments?.loadInlineThreadContexts,
    "inline thread loading",
  )({ change: harness.change });
  const context = contexts.find((item) => item.findingId === "finding-right");
  if (!context) throw new Error("Conformance harness did not publish an inline thread");
  return context;
}

function threadAction(
  kind: ThreadAction["kind"],
  context: {
    findingId: string;
    findingHeadSha: string;
    parentCommentId: string;
    threadId?: string;
  },
  body: string,
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

function findingStatus(state: PriorReviewState | undefined) {
  return state?.findings.find((finding) => finding.id === "finding-right")?.status;
}

function plannedItems(multiline: boolean): InlinePublicationItem[] {
  return [
    inlineItem({
      id: "finding-right",
      path: "src/new.ts",
      side: "RIGHT",
      startLine: 2,
      endLine: multiline ? 4 : 2,
    }),
    inlineItem({
      id: "finding-left",
      path: "src/new.ts",
      previousPath: "src/old.ts",
      side: "LEFT",
      startLine: 6,
      endLine: multiline ? 7 : 6,
    }),
  ];
}

function plannedFindingIds(multiline: boolean): string[] {
  return plannedItems(multiline)
    .map((item) => item.findingId)
    .sort();
}

function expectedAnchors(multiline: boolean): ObservedInlineAnchor[] {
  return sortAnchors(
    plannedItems(multiline).map((item) => ({
      path: item.path,
      ...(item.previousPath ? { previousPath: item.previousPath } : {}),
      side: item.side,
      startLine: item.startLine,
      endLine: item.endLine,
      headSha: item.reviewedHeadSha,
    })),
  );
}

function sortAnchors(anchors: ObservedInlineAnchor[]): ObservedInlineAnchor[] {
  return [...anchors].sort((left, right) => left.side.localeCompare(right.side));
}

function publicationPlan(change: ChangeRequestEventContext, multiline: boolean) {
  const items = plannedItems(multiline);
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

async function withHarness(
  createHarness: HarnessFactory,
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

function requiredProgress(adapter: CodeHostAdapter) {
  return requiredMethod(
    requiredPublication(adapter).publishReviewProgress,
    "review progress publication",
  );
}

function requiredComments(adapter: CodeHostAdapter) {
  return {
    loadPriorReviewState: requiredMethod(
      adapter.comments?.loadPriorReviewState,
      "prior review state loading",
    ),
  };
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
