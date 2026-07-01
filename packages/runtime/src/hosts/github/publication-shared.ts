import { firstNonEmptyLine } from "../../commands/grammar.js";
import { parseMainCommentIdentity } from "../../review/prior-state.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type {
  GitHubIssueComment,
  GitHubPublicationClient,
  GitHubReviewComment,
  GitHubReviewThread,
} from "./publication-client.js";

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

export async function currentHeadShaMismatch(
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

export async function listOwnedReviewComments(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  ownerLogin: string;
}): Promise<GitHubReviewComment[]> {
  return (
    await options.client.listReviewComments({
      repo: options.change.repository.slug,
      pullRequestNumber: options.change.change.number,
    })
  ).filter((comment) => comment.authorLogin === options.ownerLogin);
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

export function commitUrlFor(change: ChangeRequestEventContext, sha: string): string {
  const repoUrl = change.repository.url ?? `https://github.com/${change.repository.slug}`;
  return `${repoUrl.replace(/\/$/, "")}/commit/${sha}`;
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
