import type { InlinePublicationItem } from "../../publication/types.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { LoadedPublicationState, PublicationDriver } from "../publication/workflow.js";
import { normalizeBitbucketMarkdown, renderBitbucketMarkdown } from "./markdown.js";
import type { BitbucketClient } from "./models.js";
import {
  assertCurrentBitbucketEndpoints,
  authenticatedBitbucketOwner,
  bitbucketInline,
  bitbucketInlineLocation,
  bitbucketInlineLocationFromComment,
  bitbucketThreadContexts,
  findBitbucketMainComment,
  findBitbucketTopLevelComment,
} from "./publication.js";

type Prepared = { client: BitbucketClient; change: ChangeRequestEventContext };

export function createBitbucketPublicationDriver(
  client: BitbucketClient,
): PublicationDriver<Prepared> {
  return {
    provider: "Bitbucket",
    async prepare(change) {
      return { client, change };
    },
    assertCurrent(prepared, expectedHeadSha) {
      return assertCurrentBitbucketEndpoints(client, prepared.change, expectedHeadSha);
    },
    async loadOwnedState(prepared, mainMarker): Promise<LoadedPublicationState> {
      const owner = await authenticatedBitbucketOwner(client);
      const comments = await client.listComments(prepared.change.change.number);
      const owned = comments.filter((comment) => comment.user?.uuid === owner.uuid);
      const main = findBitbucketMainComment(owned, prepared.change.change.number, mainMarker);
      return {
        main: main
          ? { id: main.id, body: normalizeBitbucketMarkdown(main.content.raw) }
          : undefined,
        inline: owned.flatMap((comment) =>
          comment.parent
            ? []
            : [
                {
                  body: normalizeBitbucketMarkdown(comment.content.raw),
                  location: bitbucketInlineLocationFromComment(comment),
                  resolved: comment.resolution !== undefined,
                },
              ],
        ),
        threads: bitbucketThreadContexts(comments, owner.uuid, true),
      };
    },
    async loadOwnedMain(prepared, mainMarker) {
      const main = findBitbucketMainComment(
        await loadOwned(client, prepared),
        prepared.change.change.number,
        mainMarker,
      );
      return main ? { id: main.id, body: normalizeBitbucketMarkdown(main.content.raw) } : undefined;
    },
    upsertMain: (prepared, existing, body) =>
      upsertBitbucketComment(client, prepared, existing, body),
    inlineLocation: (_prepared, item) => bitbucketInlineLocation(item),
    async createInline(prepared, item: InlinePublicationItem) {
      await client.createComment(prepared.change.change.number, {
        content: { raw: renderBitbucketMarkdown(item.body) },
        inline: bitbucketInline(item, client.deployment),
      });
    },
    async loadOwnedCommand(prepared, marker) {
      const comment = findBitbucketTopLevelComment(
        await loadOwned(client, prepared),
        (firstLine) => firstLine === marker,
      );
      return comment
        ? { id: comment.id, body: normalizeBitbucketMarkdown(comment.content.raw) }
        : undefined;
    },
    upsertCommand: (prepared, existing, body) =>
      upsertBitbucketComment(client, prepared, existing, body),
    async replyThread(prepared, action, body) {
      const rootId = action.threadId ?? action.commentId;
      await client.replyToComment(
        prepared.change.change.number,
        rootId,
        renderBitbucketMarkdown(body),
      );
    },
    async resolveThread(prepared, action) {
      await client.resolveComment(
        prepared.change.change.number,
        action.threadId ?? action.commentId,
      );
    },
  };
}

async function loadOwned(client: BitbucketClient, prepared: Prepared) {
  const owner = await authenticatedBitbucketOwner(client);
  return (await client.listComments(prepared.change.change.number)).filter(
    (comment) => comment.user?.uuid === owner.uuid,
  );
}

async function upsertBitbucketComment(
  client: BitbucketClient,
  prepared: Prepared,
  existing: { id: string } | undefined,
  body: string,
) {
  const rendered = renderBitbucketMarkdown(body);
  const comment = existing
    ? await client.updateComment(prepared.change.change.number, existing.id, rendered)
    : await client.createComment(prepared.change.change.number, { content: { raw: rendered } });
  return { id: comment.id, action: existing ? ("updated" as const) : ("created" as const) };
}
