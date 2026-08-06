import type { InlinePublicationItem, ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import { extractInlineFindingMarkerRecords } from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type {
  LoadedPublicationState,
  OwnedMainComment,
  PublicationDriver,
} from "../publication/workflow.js";
import { mapFindingToGithubReviewCommentLocation } from "./inline.js";
import type { GitHubPublicationClient, GitHubReviewComment } from "./publication-client.js";
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
    async upsertMain(prepared, existing, body) {
      if (existing) {
        const updated = await client.updateIssueComment({
          repo: prepared.change.repository.slug,
          commentId: Number(existing.id),
          body,
        });
        return { id: String(updated.id), action: "updated" };
      }
      const created = await client.createIssueComment({
        repo: prepared.change.repository.slug,
        issueNumber: prepared.change.change.number,
        body,
      });
      return { id: String(created.id), action: "created" };
    },
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
    async upsertCommand(prepared, existing, body) {
      if (existing) {
        const updated = await client.updateIssueComment({
          repo: prepared.change.repository.slug,
          commentId: Number(existing.id),
          body,
        });
        return { id: String(updated.id), action: "updated" };
      }
      const created = await client.createIssueComment({
        ...issueCoordinates(prepared),
        body,
      });
      return { id: String(created.id), action: "created" };
    },
    async replyThread(prepared, action, body) {
      await client.createReviewCommentReply({
        repo: prepared.change.repository.slug,
        pullRequestNumber: prepared.change.change.number,
        commentId: Number(action.commentId),
        body,
      });
    },
    async resolveThread(prepared, action) {
      const threads = await client.listReviewThreads(reviewCoordinates(prepared));
      const byComment = reviewThreadByCommentId(threads);
      const thread =
        (action.threadId
          ? threads.find((candidate) => candidate.id === action.threadId)
          : undefined) ?? byComment.get(Number(action.commentId));
      const threadId = action.threadId ?? thread?.id;
      if (!threadId)
        throw new Error(`GitHub review thread not found for pipr finding '${action.findingId}'`);
      if (thread && !thread.viewerCanResolve) {
        throw new Error(
          `resolve thread '${threadId}' for finding '${action.findingId}': the GitHub credential cannot resolve this review thread; configure GITHUB_TOKEN with a user credential that can resolve pull request review threads`,
        );
      }
      if (!thread?.isResolved) await client.resolveReviewThread({ threadId });
    },
  };
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
  const commentById = new Map(reviewComments.map((comment) => [comment.id, comment]));
  return {
    main: main ? { id: String(main.id), body: main.body ?? undefined } : undefined,
    inline: owned.map((comment) => ({
      body: comment.body ?? "",
      location: locationFromComment(comment),
      resolved: threadByComment.get(comment.id)?.isResolved ?? false,
    })),
    threads: owned.flatMap((comment) => {
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
    }),
  };
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
