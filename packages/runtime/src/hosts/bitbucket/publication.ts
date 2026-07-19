import type { InlinePublicationItem, PublicationPlan, ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import {
  applyInlineFindingMarkers,
  applyNativeThreadResolutions,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  type PriorReviewState,
} from "../../review/prior-state.js";
import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  type CommandResponsePublicationOptions,
  type CommandStatusPublicationOptions,
  commandResponsePublication,
  commandStatusPublication,
  completeHostPublication,
  nativeInlineLocation,
  publishUnseenInlineItems,
  shouldUpdateCommandComment,
  threadActionReply,
} from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type { BitbucketClient, BitbucketComment } from "./client.js";
import { normalizeBitbucketMarkdown, renderBitbucketMarkdown } from "./markdown.js";

export async function publishBitbucketPlan(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  await assertCurrentEndpoints(options.client, options.change);
  const { owner, comments } = await loadBitbucketWriteState(
    options.client,
    options.change,
    options.plan.metadata.reviewedHeadSha,
  );
  const owned = comments.filter((comment) => comment.user?.uuid === owner.uuid);
  const existingMain = owned.find((comment) =>
    normalizeBitbucketMarkdown(comment.content.raw).includes(
      mainMarker(options.change.change.number),
    ),
  );
  const mainComment = renderBitbucketMarkdown(options.plan.mainComment);
  const main = existingMain
    ? await options.client.updateComment(options.change.change.number, existingMain.id, mainComment)
    : await options.client.createComment(options.change.change.number, {
        content: { raw: mainComment },
      });
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: owned.map((comment) => normalizeBitbucketMarkdown(comment.content.raw)),
    existingLocations: bitbucketInlineLocations(owned),
    location: bitbucketInlineLocation,
    publish: (item) =>
      options.client.createComment(options.change.change.number, {
        content: { raw: renderBitbucketMarkdown(item.body) },
        inline: bitbucketInline(item),
      }),
  });
  const resolution = await publishBitbucketThreadActions({
    client: options.client,
    change: options.change,
    actions: options.plan.threadActions,
    reviewedHeadSha: options.plan.metadata.reviewedHeadSha,
    comments,
    ownerUuid: owner.uuid,
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

function bitbucketInlineLocations(comments: BitbucketComment[]): InlinePublicationLocation[] {
  const locations: InlinePublicationLocation[] = [];
  for (const comment of comments) {
    const location = bitbucketInlineLocationFromComment(comment);
    if (location) locations.push(location);
  }
  return locations;
}

function bitbucketInlineLocationFromComment(
  comment: BitbucketComment,
): InlinePublicationLocation | undefined {
  const marker = extractInlineFindingMarkerRecords([
    normalizeBitbucketMarkdown(comment.content.raw),
  ])[0];
  const inline = comment.inline;
  if (!marker || !inline?.path) return undefined;
  return nativeInlineLocation({
    commitId: marker.head,
    rightPath: inline.path,
    leftPath: inline.path,
    rightStart: inline.start_to ?? undefined,
    rightEnd: inline.to ?? undefined,
    leftStart: inline.start_from ?? undefined,
    leftEnd: inline.from ?? undefined,
  });
}

function bitbucketInlineLocation(item: InlinePublicationItem): InlinePublicationLocation {
  return {
    path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

export async function publishBitbucketCommandResponse(
  options: CommandResponsePublicationOptions<BitbucketClient>,
) {
  return await publishBitbucketCommandComment({
    client: options.client,
    change: options.change,
    ...commandResponsePublication(options),
  });
}

export async function publishBitbucketCommandStatus(
  options: CommandStatusPublicationOptions<BitbucketClient>,
) {
  return await publishBitbucketCommandComment({
    client: options.client,
    change: options.change,
    ...commandStatusPublication(options),
  });
}

async function publishBitbucketCommandComment(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
  guardHead: boolean;
  comment: { marker: string; body: string };
}) {
  if (options.guardHead) {
    await assertCurrentEndpoints(options.client, options.change);
  }
  const { owner, comments } = await loadBitbucketWriteState(
    options.client,
    options.change,
    options.change.change.head.sha,
    options.guardHead,
  );
  const existing = comments.find(
    (comment) =>
      comment.user?.uuid === owner.uuid &&
      normalizeBitbucketMarkdown(comment.content.raw).includes(options.comment.marker),
  );
  const responseBody = renderBitbucketMarkdown(options.comment.body);
  if (
    existing &&
    !shouldUpdateCommandComment({
      existingBody: normalizeBitbucketMarkdown(existing.content.raw),
      nextBody: options.comment.body,
      guardHead: options.guardHead,
    })
  ) {
    return { action: "updated" as const, id: existing.id };
  }
  const comment = existing
    ? await options.client.updateComment(options.change.change.number, existing.id, responseBody)
    : await options.client.createComment(options.change.change.number, {
        content: { raw: responseBody },
      });
  return { action: existing ? ("updated" as const) : ("created" as const), id: comment.id };
}

async function loadBitbucketWriteState(
  client: BitbucketClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
  guardHead = true,
) {
  const owner = await authenticatedBitbucketOwner(client);
  const comments = await client.listComments(change.change.number);
  if (guardHead) {
    await assertCurrentEndpoints(client, change, reviewedHeadSha);
  }
  return { owner, comments };
}

export async function loadBitbucketPriorReviewState(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const comments = await loadBitbucketOwnedComments(options);
  const body = comments.find((comment) =>
    normalizeBitbucketMarkdown(comment.content.raw).includes(
      mainMarker(options.change.change.number),
    ),
  )?.content.raw;
  const normalizedBody = body ? normalizeBitbucketMarkdown(body) : undefined;
  const state = extractPriorReviewState(normalizedBody, options.change.change.number);
  if (!state) return undefined;
  const bodies = comments.map((comment) => normalizeBitbucketMarkdown(comment.content.raw));
  const markerState = applyResolvedFindingMarkers(applyInlineFindingMarkers(state, bodies), bodies);
  return applyNativeThreadResolutions(
    markerState,
    comments.flatMap((comment) => {
      const marker = !comment.parent
        ? extractInlineFindingMarkerRecords([normalizeBitbucketMarkdown(comment.content.raw)])[0]
        : undefined;
      return marker
        ? [
            {
              findingId: marker.id,
              findingHeadSha: marker.head,
              resolved: comment.resolution !== undefined,
            },
          ]
        : [];
    }),
  );
}

export async function loadBitbucketPriorMainComment(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}) {
  const body = (await loadBitbucketOwnedComments(options)).find((comment) =>
    normalizeBitbucketMarkdown(comment.content.raw).includes(
      mainMarker(options.change.change.number),
    ),
  )?.content.raw;
  return body ? normalizeBitbucketMarkdown(body) : undefined;
}

async function loadBitbucketOwnedComments(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}) {
  const owner = await authenticatedBitbucketOwner(options.client);
  return (await options.client.listComments(options.change.change.number)).filter(
    (comment) => comment.user?.uuid === owner.uuid,
  );
}

export async function loadBitbucketInlineThreadContexts(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const owner = await authenticatedBitbucketOwner(options.client);
  const comments = await options.client.listComments(options.change.change.number);
  return comments.flatMap((root) => {
    const marker = extractInlineFindingMarkerRecords([
      normalizeBitbucketMarkdown(root.content.raw),
    ])[0];
    if (!marker || root.user?.uuid !== owner.uuid || root.parent) return [];
    const replies = comments.filter((comment) => comment.parent?.id === root.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: normalizeBitbucketMarkdown(root.content.raw),
        threadId: root.id,
        threadResolved: root.resolution !== undefined,
        comments: [root, ...replies].map((comment) => ({
          id: comment.id,
          body: normalizeBitbucketMarkdown(comment.content.raw),
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
  ownerUuid?: string;
}) {
  if (options.actions.length === 0) return { errors: [] };
  await assertCurrentEndpoints(options.client, options.change, options.reviewedHeadSha);
  const comments =
    options.comments ?? (await options.client.listComments(options.change.change.number));
  const ownerUuid = options.ownerUuid ?? (await authenticatedBitbucketOwner(options.client)).uuid;
  if (!ownerUuid) throw new Error("Bitbucket authenticated user UUID is required");
  await assertCurrentEndpoints(options.client, options.change, options.reviewedHeadSha);
  const errors: string[] = [];
  for (const action of options.actions) {
    const error = await publishBitbucketThreadAction(
      options.client,
      options.change.change.number,
      comments,
      action,
      ownerUuid,
    );
    if (error) errors.push(error);
  }
  return { errors };
}

async function publishBitbucketThreadAction(
  client: BitbucketClient,
  changeNumber: number,
  comments: BitbucketComment[],
  action: ThreadAction,
  ownerUuid: string,
): Promise<string | undefined> {
  const root = comments.find(
    (comment) => comment.id === (action.threadId ?? action.commentId) && !comment.parent,
  );
  if (!root) return `Bitbucket comment not found for ${action.commentId}`;
  try {
    const replies = comments.filter((comment) => comment.parent?.id === root.id);
    const reply = threadActionReply(action);
    if (
      !replies.some(
        (comment) =>
          comment.user?.uuid === ownerUuid &&
          normalizeBitbucketMarkdown(comment.content.raw).includes(reply.marker),
      )
    ) {
      await client.replyToComment(changeNumber, root.id, renderBitbucketMarkdown(reply.body));
    }
    if (action.kind === "resolve" && root.resolution === undefined) {
      await client.resolveComment(changeNumber, root.id);
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

async function authenticatedBitbucketOwner(client: BitbucketClient): Promise<{ uuid: string }> {
  const owner = await client.currentUser();
  if (!owner.uuid) throw new Error("Bitbucket authenticated user UUID is required");
  return { uuid: owner.uuid };
}

function mainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}
