import { describe, expect, it } from "bun:test";
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
  supersedeProgressDuringPreflight(body: string): void;
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
  capabilities: CodeHostCapabilities;
  createHarness(): Promise<CodeHostAdapterConformanceHarness> | CodeHostAdapterConformanceHarness;
}): void {
  describe(`${options.name} code host adapter conformance`, () => {
    it("declares the capabilities covered by this conformance suite", async () => {
      await withHarness(options.createHarness, async (harness) => {
        expect(harness.adapter.capabilities).toEqual(options.capabilities);
      });
    });

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
        if (options.capabilities.reviewCommentReplies) {
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

    const statusIt = options.capabilities.statuses ? it : it.skip;
    for (const conclusion of ["success", "failure", "neutral"] as const) {
      statusIt(`transitions a status from pending to ${conclusion}`, async () => {
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

function requiredStatuses(adapter: CodeHostAdapter) {
  if (!adapter.statuses) throw new Error(`${adapter.id} statuses are required`);
  return adapter.statuses;
}
