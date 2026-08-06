import type { InlinePublicationItem } from "../../review/comment.js";
import { extractInlineFindingMarkerRecords } from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { LoadedPublicationState, PublicationDriver } from "../publication/workflow.js";
import type { BitbucketClient, BitbucketComment } from "./client.js";
import { normalizeBitbucketMarkdown, renderBitbucketMarkdown } from "./markdown.js";
import {
  assertCurrentBitbucketEndpoints,
  authenticatedBitbucketOwner,
  bitbucketInline,
  bitbucketInlineLocation,
  bitbucketInlineLocationFromComment,
  bitbucketMainMarker,
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
    async loadOwnedState(prepared): Promise<LoadedPublicationState> {
      const owner = await authenticatedBitbucketOwner(client);
      const comments = await client.listComments(prepared.change.change.number);
      const owned = comments.filter((comment) => comment.user?.uuid === owner.uuid);
      const main = owned.find((comment) =>
        normalizeBitbucketMarkdown(comment.content.raw).includes(
          bitbucketMainMarker(prepared.change.change.number),
        ),
      );
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
        threads: bitbucketThreadContexts(comments, owner.uuid),
      };
    },
    async upsertMain(prepared, existing, body) {
      const rendered = renderBitbucketMarkdown(body);
      const comment = existing
        ? await client.updateComment(prepared.change.change.number, existing.id, rendered)
        : await client.createComment(prepared.change.change.number, { content: { raw: rendered } });
      return { id: comment.id, action: existing ? "updated" : "created" };
    },
    inlineLocation: (_prepared, item) => bitbucketInlineLocation(item),
    async createInline(prepared, item: InlinePublicationItem) {
      await client.createComment(prepared.change.change.number, {
        content: { raw: renderBitbucketMarkdown(item.body) },
        inline: bitbucketInline(item, client.deployment),
      });
    },
    async loadOwnedCommand(prepared, marker) {
      const owner = await authenticatedBitbucketOwner(client);
      const comments = await client.listComments(prepared.change.change.number);
      const comment = comments.find(
        (candidate) =>
          candidate.user?.uuid === owner.uuid &&
          normalizeBitbucketMarkdown(candidate.content.raw).includes(marker),
      );
      return comment
        ? { id: comment.id, body: normalizeBitbucketMarkdown(comment.content.raw) }
        : undefined;
    },
    async upsertCommand(prepared, existing, body) {
      const rendered = renderBitbucketMarkdown(body);
      const comment = existing
        ? await client.updateComment(prepared.change.change.number, existing.id, rendered)
        : await client.createComment(prepared.change.change.number, { content: { raw: rendered } });
      return { id: comment.id, action: existing ? "updated" : "created" };
    },
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

function bitbucketThreadContexts(comments: BitbucketComment[], ownerUuid: string) {
  return comments.flatMap((root) => {
    const marker = extractInlineFindingMarkerRecords([
      normalizeBitbucketMarkdown(root.content.raw),
    ])[0];
    if (!marker || root.user?.uuid !== ownerUuid || root.parent) return [];
    const replies = comments.filter((comment) => comment.parent?.id === root.id);
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: normalizeBitbucketMarkdown(root.content.raw),
        threadId: root.id,
        threadResolved: root.resolution !== undefined,
        comments: [root, ...replies].flatMap((comment) =>
          comment.user?.uuid === ownerUuid
            ? [
                {
                  id: comment.id,
                  body: normalizeBitbucketMarkdown(comment.content.raw),
                  authorLogin: comment.user?.nickname,
                },
              ]
            : [],
        ),
      },
    ];
  });
}
