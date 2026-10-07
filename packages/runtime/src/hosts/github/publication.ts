import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { InlineThreadContext, PriorReviewState } from "../../publication/types.js";
import {
  applyInlineFindingMarkers,
  applyNativeThreadResolutions,
  applyResolvedFindingMarkers,
  extractPriorReviewState,
  mainCommentMarker,
  parseInlineFindingMarker,
} from "../../review/prior-state.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { isMainCommentLine } from "../publication.js";
import type {
  GitHubIssueComment,
  GitHubPublicationClient,
  GitHubReviewComment,
  GitHubReviewThread,
} from "./client.js";

export async function assertCurrentHeadSha(
  client: GitHubPublicationClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha: string,
): Promise<void> {
  const headMismatch = await currentHeadShaMismatch(client, change, reviewedHeadSha);
  if (headMismatch) {
    throw new PublicationError(headMismatch, undefined);
  }
}

async function currentHeadShaMismatch(
  client: GitHubPublicationClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha: string,
): Promise<string | undefined> {
  const currentHeadSha = await client.getPullRequestHeadSha({
    repo: change.repository.slug,
    pullRequestNumber: change.change.number,
  });
  return currentHeadSha === reviewedHeadSha
    ? undefined
    : `Change request head changed from '${reviewedHeadSha}' to '${currentHeadSha}' before publication`;
}

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

export async function loadGitHubPriorReviewState(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const mainComment = await loadGitHubPriorMainComment({ ...options, ownerLogin });
  const state = extractPriorReviewState(mainComment, options.change.change.number);
  if (!state) {
    return undefined;
  }
  const { ownerComments, threadByCommentId } = await loadOwnedReviewThreads(options, ownerLogin);
  const inlineBodies = ownerComments.map((comment) => comment.body ?? "");
  const markerState = applyResolvedFindingMarkers(
    applyInlineFindingMarkers(state, inlineBodies),
    inlineBodies,
  );
  return applyNativeThreadResolutions(
    markerState,
    ownerComments.flatMap((comment) => {
      const marker = parseInlineFindingMarker(comment.body ?? "");
      const thread = threadByCommentId.get(comment.id);
      return marker && thread
        ? [{ findingId: marker.id, findingHeadSha: marker.head, resolved: thread.isResolved }]
        : [];
    }),
  );
}

export async function loadGitHubInlineThreadContexts(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const { comments, ownerComments, threads } = await loadOwnedReviewThreads(options, ownerLogin);
  return githubThreadContexts(ownerComments, comments, threads, ownerLogin, false);
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

async function loadOwnedReviewThreads(
  options: {
    client: GitHubPublicationClient;
    change: ChangeRequestEventContext;
  },
  ownerLogin: string,
) {
  const coordinates = {
    repo: options.change.repository.slug,
    pullRequestNumber: options.change.change.number,
  };
  const comments = await options.client.listReviewComments(coordinates);
  const threads = await options.client.listReviewThreads(coordinates);
  return {
    comments,
    threads,
    ownerComments: comments.filter((comment) => comment.authorLogin === ownerLogin),
    threadByCommentId: reviewThreadByCommentId(threads),
  };
}

export async function loadGitHubPriorMainComment(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  ownerLogin?: string;
}): Promise<string | undefined> {
  const ownerLogin = options.ownerLogin ?? (await options.client.getAuthenticatedUserLogin());
  const mainComment = findMainComment(
    await options.client.listIssueComments({
      repo: options.change.repository.slug,
      issueNumber: options.change.change.number,
    }),
    mainCommentMarker,
    options.change.change.number,
    ownerLogin,
  );
  return mainComment?.body ?? undefined;
}
