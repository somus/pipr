import type { ChangeRequestEventContext } from "../../types.js";
import {
  commandResponsePublication,
  commandStatusPublication,
  shouldUpdateCommandComment,
} from "../publication.js";
import type { CommandLifecycleState } from "../types.js";
import type { GitHubIssueComment, GitHubPublicationClient } from "./publication-client.js";
import { assertCurrentHeadSha, findOwnedIssueComment } from "./publication-shared.js";

export async function publishGitHubCommandResponse(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  sourceCommentId: number;
  commandName: string;
  body: string;
}): Promise<{ action: "created" | "updated"; id: string }> {
  return await publishGitHubCommandComment({
    client: options.client,
    change: options.change,
    ...commandResponsePublication({
      client: options.client,
      change: options.change,
      sourceCommentId: String(options.sourceCommentId),
      commandName: options.commandName,
      body: options.body,
    }),
  });
}

export async function publishGitHubCommandStatus(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  sourceCommentId: number;
  commandName: string;
  state: CommandLifecycleState;
  reviewedHeadSha: string;
  currentHeadSha?: string;
}): Promise<{ action: "created" | "updated"; id: string }> {
  return await publishGitHubCommandComment({
    client: options.client,
    change: options.change,
    ...commandStatusPublication({
      client: options.client,
      change: options.change,
      sourceCommentId: String(options.sourceCommentId),
      commandName: options.commandName,
      state: options.state,
      reviewedHeadSha: options.reviewedHeadSha,
      currentHeadSha: options.currentHeadSha,
    }),
  });
}

async function publishGitHubCommandComment(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  guardHead: boolean;
  comment: { marker: string; body: string };
}): Promise<{ action: "created" | "updated"; id: string }> {
  if (options.guardHead) {
    await assertCurrentHeadSha(options.client, options.change, options.change.change.head.sha);
  }
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const comments = await options.client.listIssueComments({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
  });
  if (options.guardHead) {
    await assertCurrentHeadSha(options.client, options.change, options.change.change.head.sha);
  }
  const existing = findCommandResponseComment(comments, options.comment.marker, ownerLogin);
  if (existing) {
    if (
      !shouldUpdateCommandComment({
        existingBody: existing.body ?? "",
        nextBody: options.comment.body,
        guardHead: options.guardHead,
      })
    ) {
      return { action: "updated", id: String(existing.id) };
    }
    const updated = await options.client.updateIssueComment({
      repo: options.change.repository.slug,
      commentId: existing.id,
      body: options.comment.body,
    });
    return { action: "updated", id: String(updated.id) };
  }
  const created = await options.client.createIssueComment({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
    body: options.comment.body,
  });
  return { action: "created", id: String(created.id) };
}

function findCommandResponseComment(
  comments: GitHubIssueComment[],
  marker: string,
  ownerLogin: string,
): GitHubIssueComment | undefined {
  return findOwnedIssueComment(comments, ownerLogin, (firstLine) => firstLine === marker);
}
