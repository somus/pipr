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
import {
  extractReviewProgressToken,
  type ReviewProgressLease,
  ReviewProgressSupersededError,
} from "../../review/progress.js";
import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  assertHostInlinePublicationSucceeded,
  assertHostPublicationWriteAllowed,
  commandResponseBody,
  completeHostPublication,
  hostPublicationActionError,
  nativeInlineLocation,
  publishUnseenInlineItems,
  threadActionReply,
} from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type { BitbucketClient, BitbucketComment } from "./client.js";
import { normalizeBitbucketMarkdown, renderBitbucketMarkdown } from "./markdown.js";

export function bitbucketInlineLocationFromComment(
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
    leftPath: inline.src_path ?? inline.path,
    rightStart: inline.start_to ?? undefined,
    rightEnd: inline.to ?? undefined,
    leftStart: inline.start_from ?? undefined,
    leftEnd: inline.from ?? undefined,
  });
}

export function bitbucketInlineLocation(item: InlinePublicationItem): InlinePublicationLocation {
  return {
    path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

export async function loadBitbucketPriorReviewState(options: {
  client: BitbucketClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const comments = await loadBitbucketOwnedComments(options);
  const body = comments.find((comment) =>
    normalizeBitbucketMarkdown(comment.content.raw).includes(
      bitbucketMainMarker(options.change.change.number),
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
      bitbucketMainMarker(options.change.change.number),
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

export function bitbucketInline(
  item: InlinePublicationItem,
  deployment: BitbucketClient["deployment"],
) {
  return item.side === "RIGHT"
    ? {
        path: item.path,
        to: item.endLine,
        ...(item.startLine !== item.endLine ? { start_to: item.startLine } : {}),
      }
    : {
        path: deployment === "data-center" ? item.path : (item.previousPath ?? item.path),
        ...(deployment === "data-center" && item.previousPath
          ? { src_path: item.previousPath }
          : {}),
        from: item.endLine,
        ...(item.startLine !== item.endLine ? { start_from: item.startLine } : {}),
      };
}

export async function assertCurrentBitbucketEndpoints(
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

export async function authenticatedBitbucketOwner(
  client: BitbucketClient,
): Promise<{ uuid: string }> {
  const owner = await client.currentUser();
  if (!owner.uuid) throw new Error("Bitbucket authenticated user UUID is required");
  return { uuid: owner.uuid };
}

export function bitbucketMainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}
