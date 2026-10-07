import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { InlineThreadContext } from "../../publication/types.js";
import { parseInlineFindingMarker } from "../../review/comment-markers.js";
import { isMainCommentLine } from "../publication.js";
import type { GitHubIssueComment, GitHubReviewComment, GitHubReviewThread } from "./client.js";

export function reviewThreadByCommentId(
  threads: GitHubReviewThread[],
): Map<number, GitHubReviewThread> {
  const index = new Map<number, GitHubReviewThread>();
  for (const thread of threads) {
    for (const commentId of thread.commentIds) {
      index.set(commentId, thread);
    }
  }
  return index;
}

export function findOwnedIssueComment(
  comments: GitHubIssueComment[],
  ownerLogin: string,
  matchesFirstLine: (firstLine: string | undefined) => boolean,
): GitHubIssueComment | undefined {
  return comments.find((comment) => {
    if (comment.authorLogin !== ownerLogin) {
      return false;
    }
    const firstLine =
      comment.body === null || comment.body === undefined
        ? undefined
        : firstNonEmptyLine(comment.body);
    return matchesFirstLine(firstLine);
  });
}

export function findMainComment(
  comments: GitHubIssueComment[],
  marker: string,
  changeNumber: number,
  ownerLogin: string,
): GitHubIssueComment | undefined {
  return findOwnedIssueComment(comments, ownerLogin, (firstLine) =>
    isMainCommentLine(firstLine, marker, changeNumber),
  );
}

/**
 * Builds thread contexts rooted at owned finding comments. With `ownedRepliesOnly`,
 * only owned replies are kept and an unthreaded root still lists itself.
 */
export function githubThreadContexts(
  owned: GitHubReviewComment[],
  reviewComments: GitHubReviewComment[],
  threads: GitHubReviewThread[],
  ownerLogin: string,
  ownedRepliesOnly: boolean,
): InlineThreadContext[] {
  const threadByComment = reviewThreadByCommentId(threads);
  const commentById = new Map(reviewComments.map((comment) => [comment.id, comment]));
  const threadComments = (ids: readonly number[]) =>
    ids.flatMap((id) => {
      const item = commentById.get(id);
      return item && (!ownedRepliesOnly || item.authorLogin === ownerLogin)
        ? [{ id: String(item.id), body: item.body ?? "", authorLogin: item.authorLogin }]
        : [];
    });
  return owned.flatMap((comment) => {
    const marker = parseInlineFindingMarker(comment.body ?? "");
    if (!marker) return [];
    const thread = threadByComment.get(comment.id);
    const ids = thread?.commentIds ?? (ownedRepliesOnly ? [comment.id] : []);
    return [githubThreadContext(comment, marker, thread, threadComments(ids))];
  });
}

function githubThreadContext(
  comment: GitHubReviewComment,
  marker: { id: string; head: string },
  thread: GitHubReviewThread | undefined,
  comments: InlineThreadContext["comments"],
): InlineThreadContext {
  return {
    findingId: marker.id,
    findingHeadSha: marker.head,
    parentCommentId: String(comment.id),
    parentBody: comment.body ?? "",
    threadId: thread?.id,
    threadResolved: thread?.isResolved ?? false,
    comments,
  };
}
