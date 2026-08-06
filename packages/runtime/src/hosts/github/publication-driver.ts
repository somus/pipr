import type { ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import { extractInlineFindingMarkerRecords } from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { LoadedPublicationState, PublicationDriver } from "../publication/workflow.js";
import { mapFindingToGithubReviewCommentLocation } from "./inline.js";
import type {
  GitHubPublicationClient,
  GitHubReviewComment,
  GitHubReviewThread,
} from "./publication-client.js";
import {
  assertCurrentHeadSha,
  findMainComment,
  findOwnedIssueComment,
  reviewThreadByCommentId,
} from "./publication-shared.js";

type Prepared = {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
};

export function createGitHubPublicationDriver(
  client: GitHubPublicationClient,
): PublicationDriver<Prepared> {
  return {
    provider: "GitHub",
    async prepare(change) {
      return { client, change };
    },
    assertCurrent(prepared, expectedHeadSha) {
      return assertCurrentHeadSha(client, prepared.change, expectedHeadSha);
    },
    loadOwnedState,
    loadOwnedThreads,
    loadOwnedMain,
    upsertMain: (prepared, existing, body) =>
      upsertGitHubIssueComment(client, prepared, existing, body),
    inlineLocation(_prepared, item) {
      return publicationLocation(
        mapFindingToGithubReviewCommentLocation({
          finding: item.finding,
          range: item.range,
          headSha: item.reviewedHeadSha,
        }),
      );
    },
    async createInline(prepared, item) {
      const location = mapFindingToGithubReviewCommentLocation({
        finding: item.finding,
        range: item.range,
        headSha: item.reviewedHeadSha,
      });
      await client.createReviewComment({
        repo: prepared.change.repository.slug,
        pullRequestNumber: prepared.change.change.number,
        body: item.body,
        ...location,
      });
    },
    async loadOwnedCommand(prepared, marker) {
      const ownerLogin = await client.getAuthenticatedUserLogin();
      const comments = await client.listIssueComments(issueCoordinates(prepared));
      const found = findOwnedIssueComment(
        comments,
        ownerLogin,
        (firstLine) => firstLine === marker,
      );
      return found ? { id: String(found.id), body: found.body ?? undefined } : undefined;
    },
    upsertCommand: (prepared, existing, body) =>
      upsertGitHubIssueComment(client, prepared, existing, body),
    async replyThread(prepared, action, body) {
      await client.createReviewCommentReply({
        repo: prepared.change.repository.slug,
        pullRequestNumber: prepared.change.change.number,
        commentId: Number(action.commentId),
        body,
      });
    },
    resolveThread: (prepared, action) => resolveGitHubThread(client, prepared, action),
  };
}

async function resolveGitHubThread(
  client: GitHubPublicationClient,
  prepared: Prepared,
  action: ThreadAction,
): Promise<void> {
  const threads = await client.listReviewThreads(reviewCoordinates(prepared));
  const thread = githubThreadForAction(threads, action);
  const threadId = action.threadId ?? thread?.id;
  if (!threadId) {
    throw new Error(`GitHub review thread not found for pipr finding '${action.findingId}'`);
  }
  assertGitHubThreadResolvable(thread, threadId, action.findingId);
  if (!thread?.isResolved) await client.resolveReviewThread({ threadId });
}

function githubThreadForAction(threads: GitHubReviewThread[], action: ThreadAction) {
  return (
    (action.threadId ? threads.find((candidate) => candidate.id === action.threadId) : undefined) ??
    reviewThreadByCommentId(threads).get(Number(action.commentId))
  );
}

function assertGitHubThreadResolvable(
  thread: GitHubReviewThread | undefined,
  threadId: string,
  findingId: string,
): void {
  if (!thread || thread.viewerCanResolve) return;
  throw new Error(
    `resolve thread '${threadId}' for finding '${findingId}': the GitHub credential cannot resolve this review thread; configure GITHUB_TOKEN with a user credential that can resolve pull request review threads`,
  );
}

async function upsertGitHubIssueComment(
  client: GitHubPublicationClient,
  prepared: Prepared,
  existing: { id: string } | undefined,
  body: string,
) {
  if (existing) {
    const updated = await client.updateIssueComment({
      repo: prepared.change.repository.slug,
      commentId: Number(existing.id),
      body,
    });
    return { id: String(updated.id), action: "updated" as const };
  }
  const created = await client.createIssueComment({ ...issueCoordinates(prepared), body });
  return { id: String(created.id), action: "created" as const };
}

async function loadOwnedThreads(prepared: Prepared, actions: readonly ThreadAction[]) {
  const ownerLogin = await prepared.client.getAuthenticatedUserLogin();
  const reviewComments = await prepared.client.listReviewComments(reviewCoordinates(prepared));
  const owned = reviewComments.filter((comment) => comment.authorLogin === ownerLogin);
  if (!actions.some((action) => action.kind === "resolve")) {
    const comments = owned.map((comment) => ({
      id: String(comment.id),
      body: comment.body ?? "",
      authorLogin: comment.authorLogin,
    }));
    return actions.map((action) => ({
      findingId: action.findingId,
      findingHeadSha: action.findingHeadSha,
      parentCommentId: action.commentId,
      threadId: action.threadId,
      parentBody: owned.find((comment) => String(comment.id) === action.commentId)?.body ?? "",
      threadResolved: false,
      comments: [...comments],
    }));
  }
  const threads = await prepared.client.listReviewThreads(reviewCoordinates(prepared));
  return githubThreadContexts(owned, reviewComments, threads, ownerLogin);
}

async function loadOwnedMain(prepared: Prepared, mainMarker: string) {
  const ownerLogin = await prepared.client.getAuthenticatedUserLogin();
  const main = findMainComment(
    await prepared.client.listIssueComments(issueCoordinates(prepared)),
    mainMarker,
    prepared.change.change.number,
    ownerLogin,
  );
  return main ? { id: String(main.id), body: main.body ?? undefined } : undefined;
}

async function loadOwnedState(
  prepared: Prepared,
  mainMarker: string,
): Promise<LoadedPublicationState> {
  const ownerLogin = await prepared.client.getAuthenticatedUserLogin();
  const [issueComments, reviewComments, threads] = await Promise.all([
    prepared.client.listIssueComments(issueCoordinates(prepared)),
    prepared.client.listReviewComments(reviewCoordinates(prepared)),
    prepared.client.listReviewThreads(reviewCoordinates(prepared)),
  ]);
  const main = findMainComment(
    issueComments,
    mainMarker,
    prepared.change.change.number,
    ownerLogin,
  );
  const owned = reviewComments.filter((comment) => comment.authorLogin === ownerLogin);
  const threadByComment = reviewThreadByCommentId(threads);
  return {
    main: main ? { id: String(main.id), body: main.body ?? undefined } : undefined,
    inline: owned.map((comment) => ({
      body: comment.body ?? "",
      location: locationFromComment(comment),
      resolved: threadByComment.get(comment.id)?.isResolved ?? false,
    })),
    threads: githubThreadContexts(owned, reviewComments, threads, ownerLogin),
  };
}

function githubThreadContexts(
  owned: GitHubReviewComment[],
  reviewComments: GitHubReviewComment[],
  threads: GitHubReviewThread[],
  ownerLogin: string,
) {
  const threadByComment = reviewThreadByCommentId(threads);
  const commentById = new Map(reviewComments.map((comment) => [comment.id, comment]));
  return owned.flatMap((comment) => {
    const marker = extractInlineFindingMarkerRecords([comment.body ?? ""])[0];
    if (!marker) return [];
    const thread = threadByComment.get(comment.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: String(comment.id),
        parentBody: comment.body ?? "",
        threadId: thread?.id,
        threadResolved: thread?.isResolved ?? false,
        comments: (thread?.commentIds ?? [comment.id]).flatMap((id) => {
          const item = commentById.get(id);
          return item && item.authorLogin === ownerLogin
            ? [{ id: String(item.id), body: item.body ?? "", authorLogin: item.authorLogin }]
            : [];
        }),
      },
    ];
  });
}

function issueCoordinates(prepared: Prepared) {
  return { repo: prepared.change.repository.slug, issueNumber: prepared.change.change.number };
}

function reviewCoordinates(prepared: Prepared) {
  return {
    repo: prepared.change.repository.slug,
    pullRequestNumber: prepared.change.change.number,
  };
}

type GitHubLocation = ReturnType<typeof mapFindingToGithubReviewCommentLocation>;

function publicationLocation(location: GitHubLocation): InlinePublicationLocation {
  return {
    path: location.path,
    commitId: location.commit_id,
    side: location.side,
    startLine: location.start_line ?? location.line,
    endLine: location.line,
  };
}

function locationFromComment(comment: GitHubReviewComment): InlinePublicationLocation | undefined {
  if (!comment.path || !comment.commitId || !comment.side || comment.line === undefined)
    return undefined;
  return {
    path: comment.path,
    commitId: comment.commitId,
    side: comment.side,
    startLine: comment.startLine ?? comment.line,
    endLine: comment.line,
  };
}
