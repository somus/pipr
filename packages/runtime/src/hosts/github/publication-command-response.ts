import type { ChangeRequestEventContext } from "../../types.js";
import type { GitHubIssueComment, GitHubPublicationClient } from "./publication-client.js";
import {
  assertCurrentHeadSha,
  findOwnedIssueComment,
  upsertOwnedIssueComment,
} from "./publication-shared.js";

const commandResponseMarker = "pipr:command-response";

export async function publishGitHubCommandResponse(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  sourceCommentId: number;
  commandName: string;
  body: string;
}): Promise<{ action: "created" | "updated"; id: string }> {
  await assertCurrentHeadSha(options.client, options.change, options.change.change.head.sha);

  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const marker = renderCommandResponseMarker({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
  });
  const body = [marker, "", options.body, ""].join("\n");
  return upsertOwnedIssueComment({
    client: options.client,
    repo: options.change.repository.slug,
    issueNumber: options.change.change.number,
    body,
    find: (comments) => findCommandResponseComment(comments, marker, ownerLogin),
  });
}

function findCommandResponseComment(
  comments: GitHubIssueComment[],
  marker: string,
  ownerLogin: string,
): GitHubIssueComment | undefined {
  return findOwnedIssueComment(comments, ownerLogin, (firstLine) => firstLine === marker);
}

function renderCommandResponseMarker(options: {
  changeNumber: number;
  sourceCommentId: number;
  commandName: string;
}): string {
  return `<!-- ${commandResponseMarker} change=${options.changeNumber} source=${options.sourceCommentId} command=${options.commandName} -->`;
}
