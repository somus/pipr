import {
  applyInlineFindingMarkers,
  applyNativeThreadResolutions,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  mainCommentMarker,
  type PriorReviewState,
} from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { InlineThreadContext } from "../types.js";
import type { GitHubPublicationClient } from "./publication-client.js";
import { findMainComment, reviewThreadByCommentId } from "./publication-shared.js";

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
