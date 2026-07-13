import type { InlinePublicationItem, PublicationPlan, ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
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
  commandResponseBody,
  completeHostPublication,
  nativeInlineLocation,
  publishUnseenInlineItems,
  threadActionReply,
} from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type { BitbucketClient, BitbucketComment } from "./client.js";

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
    comment.content.raw.includes(mainMarker(options.change.change.number)),
  );
  const main = existingMain
    ? await options.client.updateComment(
        options.change.change.number,
        existingMain.id,
        options.plan.mainComment,
      )
    : await options.client.createComment(options.change.change.number, {
        content: { raw: options.plan.mainComment },
      });
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: owned.map((comment) => comment.content.raw),
    existingLocations: bitbucketInlineLocations(owned),
    location: bitbucketInlineLocation,
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
  const marker = extractInlineFindingMarkerRecords([comment.content.raw])[0];
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
  const { owner, comments } = await loadBitbucketWriteState(options.client, options.change);
  const existing = comments.find(
    (comment) => comment.user?.uuid === owner.uuid && comment.content.raw.includes(response.marker),
  );
  const comment = existing
    ? await options.client.updateComment(options.change.change.number, existing.id, response.body)
    : await options.client.createComment(options.change.change.number, {
        content: { raw: response.body },
      });
  return { action: existing ? ("updated" as const) : ("created" as const), id: comment.id };
}

async function loadBitbucketWriteState(
  client: BitbucketClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const owner = await authenticatedBitbucketOwner(client);
  const comments = await client.listComments(change.change.number);
  await assertCurrentEndpoints(client, change, reviewedHeadSha);
  return { owner, comments };
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
        (comment) => comment.user?.uuid === ownerUuid && comment.content.raw.includes(reply.marker),
      )
    ) {
      await client.replyToComment(changeNumber, root.id, reply.body);
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
