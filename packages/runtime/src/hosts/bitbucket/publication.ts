import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { InlinePublicationItem, InlineThreadContext } from "../../publication/types.js";
import { mainCommentMarker, parseInlineFindingMarker } from "../../review/comment-markers.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { isMainCommentLine, nativeInlineLocation } from "../publication.js";
import { normalizeBitbucketMarkdown } from "./markdown.js";
import type { BitbucketClient, BitbucketComment, BitbucketInlineRequest } from "./models.js";

export function bitbucketInlineLocationFromComment(
  comment: BitbucketComment,
): InlinePublicationLocation | undefined {
  const marker = parseInlineFindingMarker(normalizeBitbucketMarkdown(comment.content.raw));
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

export function bitbucketThreadContexts(
  comments: BitbucketComment[],
  ownerUuid: string,
  ownedRepliesOnly: boolean,
): InlineThreadContext[] {
  return comments.flatMap((root) => {
    const marker = parseInlineFindingMarker(normalizeBitbucketMarkdown(root.content.raw));
    if (!marker || root.user?.uuid !== ownerUuid || root.parent) return [];
    const replies = comments.filter((comment) => comment.parent?.id === root.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: normalizeBitbucketMarkdown(root.content.raw),
        threadId: root.id,
        threadResolved: root.resolution !== undefined,
        comments: [root, ...replies].flatMap((comment) =>
          !ownedRepliesOnly || comment.user?.uuid === ownerUuid
            ? [
                {
                  id: comment.id,
                  body: normalizeBitbucketMarkdown(comment.content.raw),
                  authorLogin: comment.user?.nickname,
                },
              ]
            : [],
        ),
      },
    ];
  });
}

export function bitbucketInline(
  item: InlinePublicationItem,
  deployment: BitbucketClient["deployment"],
): BitbucketInlineRequest {
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
  stage = "publication",
) {
  const pullRequest = await client.getPullRequest(change.change.number);
  if (
    pullRequest.source.commit.hash !== reviewedHeadSha ||
    pullRequest.destination.commit.hash !== change.change.base.sha
  ) {
    throw new Error(`Bitbucket pull request endpoints changed before ${stage}`);
  }
}

export async function authenticatedBitbucketOwner(
  client: BitbucketClient,
): Promise<{ uuid: string }> {
  const owner = await client.currentUser();
  if (!owner.uuid) throw new Error("Bitbucket authenticated user UUID is required");
  return { uuid: owner.uuid };
}

/**
 * Finds a top-level (non-inline, non-reply) comment whose first non-empty line
 * matches. Markers elsewhere in a body, or in inline finding comments, never
 * identify the main or command comment.
 */
export function findBitbucketTopLevelComment(
  comments: readonly BitbucketComment[],
  matchesFirstLine: (firstLine: string | undefined) => boolean,
): BitbucketComment | undefined {
  return comments.find(
    (comment) =>
      !comment.inline &&
      !comment.parent &&
      matchesFirstLine(firstNonEmptyLine(normalizeBitbucketMarkdown(comment.content.raw))),
  );
}

export function findBitbucketMainComment(
  comments: readonly BitbucketComment[],
  changeNumber: number,
  marker = mainCommentMarker,
): BitbucketComment | undefined {
  return findBitbucketTopLevelComment(comments, (firstLine) =>
    isMainCommentLine(firstLine, marker, changeNumber),
  );
}
