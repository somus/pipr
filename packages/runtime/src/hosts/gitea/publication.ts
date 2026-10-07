import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { InlineThreadContext } from "../../publication/types.js";
import { parseInlineFindingMarker } from "../../review/comment-markers.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { requireCoordinates } from "../change-request.js";
import type { ChangeRequestEndpoints } from "../publication/workflow.js";
import { isMainCommentLine, nativeInlineLocation } from "../publication.js";
import type { GiteaClient, GiteaComment, GiteaReviewComment } from "./client.js";

export async function currentGiteaEndpoints(
  client: GiteaClient,
  change: ChangeRequestEventContext,
): Promise<ChangeRequestEndpoints> {
  const coordinates = giteaCoordinates(change);
  const pullRequest = await client.getPullRequest(
    coordinates.owner,
    coordinates.repository,
    change.change.number,
  );
  return { headSha: pullRequest.head.sha };
}

export function giteaThreadContexts(
  comments: GiteaReviewComment[],
  ownerLogin: string,
  ownedRepliesOnly: boolean,
): InlineThreadContext[] {
  const byRoot = new Map<string, GiteaReviewComment[]>();
  for (const comment of comments) {
    const rootId = comment.parentId ?? comment.id;
    const values = byRoot.get(rootId) ?? [];
    values.push(comment);
    byRoot.set(rootId, values);
  }
  return [...byRoot.entries()].flatMap(([rootId, thread]) => {
    const root = thread.find((comment) => comment.id === rootId);
    const marker = root ? parseInlineFindingMarker(root.body) : undefined;
    if (!root || !marker || root.authorLogin !== ownerLogin) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.body,
        threadResolved: false,
        comments: thread.flatMap((comment) =>
          !ownedRepliesOnly || comment.authorLogin === ownerLogin
            ? [{ id: comment.id, body: comment.body, authorLogin: comment.authorLogin }]
            : [],
        ),
      },
    ];
  });
}

export function findGiteaMainComment(
  comments: GiteaComment[],
  ownerLogin: string,
  marker: string,
  changeNumber: number,
): GiteaComment | undefined {
  return comments.find(
    (comment) =>
      comment.authorLogin === ownerLogin &&
      isMainCommentLine(firstNonEmptyLine(comment.body), marker, changeNumber),
  );
}

export function giteaCoordinates(change: ChangeRequestEventContext) {
  return requireCoordinates(change, "gitea", "Gitea-compatible", "Gitea");
}

export function giteaReviewCommentLocation(comment: GiteaReviewComment) {
  if (!comment.path || !comment.commitId || !comment.side || comment.line === undefined) {
    return undefined;
  }
  return nativeInlineLocation({
    commitId: comment.commitId,
    rightPath: comment.path,
    leftPath: comment.path,
    ...(comment.side === "RIGHT"
      ? { rightStart: comment.line, rightEnd: comment.line }
      : { leftStart: comment.line, leftEnd: comment.line }),
  });
}
