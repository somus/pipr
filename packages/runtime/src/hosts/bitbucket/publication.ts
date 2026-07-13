import type { InlinePublicationItem, PublicationPlan, ThreadAction } from "../../review/comment.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  type PriorReviewState,
} from "../../review/prior-state.js";
import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  assertInlinePublicationComplete,
  commandResponseBody,
  completeHostPublication,
  publishUnseenInlineItems,
} from "../publication.js";
import { retryCodeHostOperation } from "../retry.js";
import type { InlineThreadContext } from "../types.js";
import type { BitbucketClient, BitbucketComment } from "./client.js";

export async function publishBitbucketPlan(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  await assertCurrentEndpoints(options.client, options.change);
  const owner = await options.client.currentUser();
  const comments = await options.client.listComments(options.change.change.number);
  const owned = comments.filter((comment) => comment.user?.uuid === owner.uuid);
  const existingMain = owned.find((comment) =>
    comment.content.raw.includes(mainMarker(options.change.change.number)),
  );
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: owned.map((comment) => comment.content.raw),
    reloadExistingBodies: async () =>
      (await options.client.listComments(options.change.change.number))
        .filter((comment) => comment.user?.uuid === owner.uuid)
        .map((comment) => comment.content.raw),
    publish: (item) =>
      options.client.createComment(options.change.change.number, {
        content: { raw: item.body },
        inline: bitbucketInline(item),
      }),
  });
  const resolution = await publishBitbucketThreadActions({
    client: options.client,
    change: options.change,
    actions: options.plan.threadActions,
    reviewedHeadSha: options.plan.metadata.reviewedHeadSha,
    comments,
  });
  assertInlinePublicationComplete({
    provider: "Bitbucket",
    inline,
    metadata: options.plan.metadata,
  });
  const main = existingMain
    ? await options.client.updateComment(
        options.change.change.number,
        existingMain.id,
        options.plan.mainComment,
      )
    : await retryCodeHostOperation({
        operation: () =>
          options.client.createComment(options.change.change.number, {
            content: { raw: options.plan.mainComment },
          }),
        reconcile: async () =>
          (await options.client.listComments(options.change.change.number)).find(
            (comment) =>
              comment.user?.uuid === owner.uuid &&
              comment.content.raw.includes(mainMarker(options.change.change.number)),
          ),
      });
  return completeHostPublication({
    provider: "Bitbucket",
    mainAction: existingMain ? "updated" : "created",
    mainId: main.id,
    inline,
    resolutionErrors: resolution.errors,
    metadata: options.plan.metadata,
  });
}

export async function publishBitbucketCommandResponse(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  body: string;
}) {
  const response = commandResponseBody({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
    body: options.body,
  });
  await assertCurrentEndpoints(options.client, options.change);
  const owner = await options.client.currentUser();
  const existing = (await options.client.listComments(options.change.change.number)).find(
    (comment) => comment.user?.uuid === owner.uuid && comment.content.raw.includes(response.marker),
  );
  const comment = existing
    ? await options.client.updateComment(options.change.change.number, existing.id, response.body)
    : await retryCodeHostOperation({
        operation: () =>
          options.client.createComment(options.change.change.number, {
            content: { raw: response.body },
          }),
        reconcile: async () =>
          (await options.client.listComments(options.change.change.number)).find(
            (comment) =>
              comment.user?.uuid === owner.uuid && comment.content.raw.includes(response.marker),
          ),
      });
  return { action: existing ? ("updated" as const) : ("created" as const), id: comment.id };
}

export async function loadBitbucketPriorReviewState(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const comments = await loadBitbucketOwnedComments(options);
  const body = comments.find((comment) =>
    comment.content.raw.includes(mainMarker(options.change.change.number)),
  )?.content.raw;
  const state = extractPriorReviewState(body, options.change.change.number);
  if (!state) return undefined;
  const bodies = comments.map((comment) => comment.content.raw);
  return applyResolvedFindingMarkers(applyInlineFindingMarkers(state, bodies), bodies);
}

export async function loadBitbucketPriorMainComment(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}) {
  return (await loadBitbucketOwnedComments(options)).find((comment) =>
    comment.content.raw.includes(mainMarker(options.change.change.number)),
  )?.content.raw;
}

async function loadBitbucketOwnedComments(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}) {
  const owner = await options.client.currentUser();
  return (await options.client.listComments(options.change.change.number)).filter(
    (comment) => comment.user?.uuid === owner.uuid,
  );
}

export async function loadBitbucketInlineThreadContexts(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const owner = await options.client.currentUser();
  const comments = await options.client.listComments(options.change.change.number);
  return comments.flatMap((root) => {
    const marker = extractInlineFindingMarkerRecords([root.content.raw])[0];
    if (!marker || root.user?.uuid !== owner.uuid || root.parent) return [];
    const replies = comments.filter((comment) => comment.parent?.id === root.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.content.raw,
        threadId: root.id,
        threadResolved: root.resolution !== undefined,
        comments: [root, ...replies].map((comment) => ({
          id: comment.id,
          body: comment.content.raw,
          authorLogin: comment.user?.nickname,
        })),
      },
    ];
  });
}

export async function publishBitbucketThreadActions(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
  actions: ThreadAction[];
  reviewedHeadSha: string;
  comments?: BitbucketComment[];
}) {
  if (options.actions.length === 0) return { errors: [] };
  await assertCurrentEndpoints(options.client, options.change, options.reviewedHeadSha);
  const comments =
    options.comments ?? (await options.client.listComments(options.change.change.number));
  const errors: string[] = [];
  for (const action of options.actions) {
    const root = comments.find(
      (comment) => comment.id === (action.threadId ?? action.commentId) && !comment.parent,
    );
    if (!root) {
      errors.push(`Bitbucket comment not found for ${action.commentId}`);
      continue;
    }
    try {
      const replies = comments.filter((comment) => comment.parent?.id === root.id);
      if (!replies.some((comment) => comment.content.raw.includes(action.responseKey)))
        await retryCodeHostOperation({
          operation: () =>
            options.client.replyToComment(options.change.change.number, root.id, action.body),
          reconcile: async () =>
            (await options.client.listComments(options.change.change.number)).find(
              (comment) =>
                comment.parent?.id === root.id && comment.content.raw.includes(action.responseKey),
            ),
        });
      if (action.kind === "resolve" && root.resolution === undefined)
        await retryCodeHostOperation({
          operation: async () => {
            await options.client.resolveComment(options.change.change.number, root.id);
            return true;
          },
          reconcile: async () =>
            (await options.client.listComments(options.change.change.number)).find(
              (comment) => comment.id === root.id && comment.resolution !== undefined,
            )
              ? true
              : undefined,
        });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { errors };
}

function bitbucketInline(item: InlinePublicationItem) {
  return item.side === "RIGHT"
    ? {
        path: item.path,
        to: item.endLine,
        ...(item.startLine !== item.endLine ? { start_to: item.startLine } : {}),
      }
    : {
        path: item.previousPath ?? item.path,
        from: item.endLine,
        ...(item.startLine !== item.endLine ? { start_from: item.startLine } : {}),
      };
}

async function assertCurrentEndpoints(
  client: BitbucketClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const pullRequest = await client.getPullRequest(change.change.number);
  if (
    pullRequest.source.commit.hash !== reviewedHeadSha ||
    pullRequest.destination.commit.hash !== change.change.base.sha
  ) {
    throw new Error("Bitbucket pull request endpoints changed before publication");
  }
}

function mainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}
