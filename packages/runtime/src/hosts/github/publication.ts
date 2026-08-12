import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { InlineThreadContext, PriorReviewState } from "../../publication/types.js";
import {
  applyInlineFindingMarkers,
  applyNativeThreadResolutions,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  mainCommentMarker,
  parseMainCommentIdentity,
} from "../../review/prior-state.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { GitHubIssueComment, GitHubPublicationClient, GitHubReviewThread } from "./client.js";

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
  return findOwnedIssueComment(comments, ownerLogin, (firstLine) => {
    const parsed = parseMainCommentIdentity(firstLine);
    return parsed?.marker === marker && parsed.changeNumber === changeNumber;
  });
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
      const marker = extractInlineFindingMarkerRecords([comment.body ?? ""])[0];
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
  const { comments, ownerComments, threadByCommentId } = await loadOwnedReviewThreads(
    options,
    ownerLogin,
  );
  const commentById = new Map(comments.map((comment) => [comment.id, comment]));

  return ownerComments.flatMap((comment) => {
    const marker = extractInlineFindingMarkerRecords([comment.body ?? ""])[0];
    if (!marker) {
      return [];
    }
    const thread = threadByCommentId.get(comment.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: String(comment.id),
        parentBody: comment.body ?? "",
        threadId: thread?.id,
        threadResolved: thread?.isResolved ?? false,
        comments:
          thread?.commentIds.flatMap((id) => {
            const item = commentById.get(id);
            return item
              ? [
                  {
                    id: String(item.id),
                    body: item.body ?? "",
                    authorLogin: item.authorLogin,
                  },
                ]
              : [];
          }) ?? [],
      },
    ];
  });
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
