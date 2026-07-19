import type { ChangeRequestEventContext } from "../../types.js";
import { commandResponseBody } from "../publication.js";
import type { GitHubIssueComment, GitHubPublicationClient } from "./publication-client.js";
import { assertCurrentHeadSha, findOwnedIssueComment } from "./publication-shared.js";

export async function publishGitHubCommandResponse(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  sourceCommentId: number;
  commandName: string;
  body: string;
  allowHeadDrift?: boolean;
}): Promise<{ action: "created" | "updated"; id: string }> {
  if (!options.allowHeadDrift) {
    await assertCurrentHeadSha(options.client, options.change, options.change.change.head.sha);
  }

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const response = commandResponseBody({
    changeNumber: options.change.change.number,
    sourceCommentId: String(options.sourceCommentId),
    commandName: options.commandName,
    body: options.body,
  });
  const comments = await options.client.listIssueComments({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
  });
  if (!options.allowHeadDrift) {
    await assertCurrentHeadSha(options.client, options.change, options.change.change.head.sha);
  }
  const existing = findCommandResponseComment(comments, response.marker, ownerLogin);
  if (existing) {
    const updated = await options.client.updateIssueComment({
      repo: options.change.repository.slug,
      commentId: existing.id,
      body: response.body,
    });
    return { action: "updated", id: String(updated.id) };
  }
  const created = await options.client.createIssueComment({
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
    body: response.body,
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
