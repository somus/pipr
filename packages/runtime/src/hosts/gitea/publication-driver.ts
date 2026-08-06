import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { InlinePublicationItem } from "../../review/comment.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { LoadedPublicationState, PublicationDriver } from "../publication/workflow.js";
import type { GiteaClient } from "./client.js";
import {
  assertCurrentGiteaHead,
  findGiteaMainComment,
  giteaCoordinates,
  giteaDisplayName,
  giteaReviewCommentLocation,
  giteaThreadContexts,
} from "./publication.js";

type Prepared = { client: GiteaClient; change: ChangeRequestEventContext };

export function createGiteaPublicationDriver(client: GiteaClient): PublicationDriver<Prepared> {
  return {
    provider: giteaDisplayName(client.host),
    async prepare(change) {
      return { client, change };
    },
    assertCurrent(prepared, expectedHeadSha) {
      return assertCurrentGiteaHead(client, prepared.change, expectedHeadSha);
    },
    async loadOwnedState(prepared): Promise<LoadedPublicationState> {
      const coordinates = giteaCoordinates(prepared.change);
      const owner = await client.currentUser();
      const [comments, reviewComments] = await Promise.all([
        client.listIssueComments(
          coordinates.owner,
          coordinates.repository,
          prepared.change.change.number,
        ),
        client.listReviewComments(
          coordinates.owner,
          coordinates.repository,
          prepared.change.change.number,
        ),
      ]);
      const main = findGiteaMainComment(
        comments,
        owner.login,
        "pipr:main-comment",
        prepared.change.change.number,
      );
      const owned = reviewComments.filter((comment) => comment.authorLogin === owner.login);
      return {
        main: main ? { id: main.id, body: main.body } : undefined,
        inline: owned.flatMap((comment) =>
          comment.parentId
            ? []
            : [
                {
                  body: comment.body,
                  location: giteaReviewCommentLocation(comment),
                  resolved: false,
                },
              ],
        ),
        threads: giteaThreadContexts(reviewComments, owner.login, true),
      };
    },
    upsertMain: (prepared, existing, body) => upsertGiteaComment(client, prepared, existing, body),
    inlineLocation(_prepared, item) {
      return {
        path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
        commitId: item.reviewedHeadSha,
        side: item.side,
        startLine: item.endLine,
        endLine: item.endLine,
      };
    },
    async createInline(prepared, item: InlinePublicationItem) {
      const coordinates = giteaCoordinates(prepared.change);
      await client.createReviewComment(
        coordinates.owner,
        coordinates.repository,
        prepared.change.change.number,
        {
          body: item.body,
          path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
          commitId: item.reviewedHeadSha,
          line: item.endLine,
          side: item.side,
        },
      );
    },
    async loadOwnedCommand(prepared, marker) {
      const coordinates = giteaCoordinates(prepared.change);
      const owner = await client.currentUser();
      const comments = await client.listIssueComments(
        coordinates.owner,
        coordinates.repository,
        prepared.change.change.number,
      );
      const comment = comments.find(
        (candidate) =>
          candidate.authorLogin === owner.login && firstNonEmptyLine(candidate.body) === marker,
      );
      return comment ? { id: comment.id, body: comment.body } : undefined;
    },
    upsertCommand: (prepared, existing, body) =>
      upsertGiteaComment(client, prepared, existing, body),
    async replyThread(prepared, action, body) {
      const coordinates = giteaCoordinates(prepared.change);
      await client.replyToReviewComment(
        coordinates.owner,
        coordinates.repository,
        prepared.change.change.number,
        action.commentId,
        body,
      );
    },
  };
}

async function upsertGiteaComment(
  client: GiteaClient,
  prepared: Prepared,
  existing: { id: string } | undefined,
  body: string,
) {
  const coordinates = giteaCoordinates(prepared.change);
  const comment = existing
    ? await client.updateIssueComment(coordinates.owner, coordinates.repository, existing.id, body)
    : await client.createIssueComment(
        coordinates.owner,
        coordinates.repository,
        prepared.change.change.number,
        body,
      );
  return { id: comment.id, action: existing ? ("updated" as const) : ("created" as const) };
}
