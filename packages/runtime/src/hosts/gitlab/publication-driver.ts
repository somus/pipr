import type { InlinePublicationItem } from "../../review/comment.js";
import { extractInlineFindingMarkerRecords } from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { LoadedPublicationState, PublicationDriver } from "../publication/workflow.js";
import type { GitLabClient, GitLabDiffRefs } from "./client.js";
import {
  assertCurrentGitLabHead,
  gitLabCoordinates,
  gitLabInlineBody,
  gitLabInlineLocation,
  gitLabInlineLocationFromDiscussion,
  gitLabMainMarker,
  gitLabPosition,
  gitLabThreadContexts,
  ownedGitLabNote,
} from "./publication.js";

type Prepared = {
  client: GitLabClient;
  change: ChangeRequestEventContext;
  ownerUsername: string;
  refs?: GitLabDiffRefs;
};

export function createGitLabPublicationDriver(client: GitLabClient): PublicationDriver<Prepared> {
  return {
    provider: "GitLab",
    async prepare(change) {
      const owner = await client.currentUser();
      return { client, change, ownerUsername: owner.username };
    },
    async assertCurrent(prepared, expectedHeadSha) {
      const current = await assertCurrentGitLabHead(client, prepared.change, expectedHeadSha);
      prepared.refs = current.diff_refs;
    },
    async loadOwnedState(prepared): Promise<LoadedPublicationState> {
      const coordinates = gitLabCoordinates(prepared.change);
      const [notes, discussions] = await Promise.all([
        client.listNotes(coordinates.projectId, prepared.change.change.number),
        client.listDiscussions(coordinates.projectId, prepared.change.change.number),
      ]);
      const main = ownedGitLabNote(
        notes,
        prepared.ownerUsername,
        gitLabMainMarker(prepared.change.change.number),
      );
      return {
        main: main ? { id: main.id, body: main.body } : undefined,
        inline: discussions.flatMap((discussion) => {
          const root = discussion.notes[0];
          if (!root || root.author?.username !== prepared.ownerUsername) return [];
          return [
            {
              body: root.body,
              location: gitLabInlineLocationFromDiscussion(discussion),
              resolved: root.resolved ?? false,
            },
          ];
        }),
        threads: gitLabThreadContexts(discussions, prepared.ownerUsername, true),
      };
    },
    async upsertMain(prepared, existing, body) {
      const coordinates = gitLabCoordinates(prepared.change);
      const note = existing
        ? await client.updateNote(
            coordinates.projectId,
            prepared.change.change.number,
            existing.id,
            body,
          )
        : await client.createNote(coordinates.projectId, prepared.change.change.number, body);
      return { id: note.id, action: existing ? "updated" : "created" };
    },
    inlineLocation: (_prepared, item) => gitLabInlineLocation(item),
    async createInline(prepared, item: InlinePublicationItem) {
      if (!prepared.refs) throw new Error("GitLab diff refs were not prepared");
      const coordinates = gitLabCoordinates(prepared.change);
      await client.createDiscussion(
        coordinates.projectId,
        prepared.change.change.number,
        gitLabInlineBody(item),
        gitLabPosition(item, prepared.refs),
      );
    },
    async loadOwnedCommand(prepared, marker) {
      const coordinates = gitLabCoordinates(prepared.change);
      const note = ownedGitLabNote(
        await client.listNotes(coordinates.projectId, prepared.change.change.number),
        prepared.ownerUsername,
        marker,
      );
      return note ? { id: note.id, body: note.body } : undefined;
    },
    async upsertCommand(prepared, existing, body) {
      const coordinates = gitLabCoordinates(prepared.change);
      const note = existing
        ? await client.updateNote(
            coordinates.projectId,
            prepared.change.change.number,
            existing.id,
            body,
          )
        : await client.createNote(coordinates.projectId, prepared.change.change.number, body);
      return { id: note.id, action: existing ? "updated" : "created" };
    },
    async replyThread(prepared, action, body) {
      const coordinates = gitLabCoordinates(prepared.change);
      const discussionId =
        action.threadId ?? (await discussionForComment(prepared, action.commentId));
      if (!discussionId)
        throw new Error(`GitLab discussion not found for comment ${action.commentId}`);
      await client.replyDiscussion(
        coordinates.projectId,
        prepared.change.change.number,
        discussionId,
        body,
      );
    },
    async resolveThread(prepared, action) {
      const coordinates = gitLabCoordinates(prepared.change);
      const discussionId =
        action.threadId ?? (await discussionForComment(prepared, action.commentId));
      if (!discussionId)
        throw new Error(`GitLab discussion not found for comment ${action.commentId}`);
      await client.resolveDiscussion(
        coordinates.projectId,
        prepared.change.change.number,
        discussionId,
      );
    },
  };
}

async function discussionForComment(prepared: Prepared, commentId: string) {
  const discussions = await prepared.client.listDiscussions(
    gitLabCoordinates(prepared.change).projectId,
    prepared.change.change.number,
  );
  return discussions.find((discussion) => discussion.notes.some((note) => note.id === commentId))
    ?.id;
}
