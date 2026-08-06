import type { InlinePublicationItem } from "../../review/comment.js";
import { extractInlineFindingMarkerRecords } from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { LoadedPublicationState, PublicationDriver } from "../publication/workflow.js";
import type { AzureDevOpsClient, AzureDevOpsIterationChange, AzureDevOpsThread } from "./client.js";
import {
  assertCurrentAzurePullRequest,
  authenticatedAzureOwner,
  azureCoordinates,
  azureInlineLocation,
  azureInlineLocationFromThread,
  azureInlineThread,
  azureMainMarker,
  currentAzureNativeChange,
  isAzureThreadResolved,
  ownedAzureRootThread,
  unpositionedAzureThread,
} from "./publication.js";

type Prepared = {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
  ownerUniqueName: string;
  iterationId?: number;
  changes?: AzureDevOpsIterationChange[];
};

export function createAzureDevOpsPublicationDriver(
  client: AzureDevOpsClient,
): PublicationDriver<Prepared> {
  return {
    provider: "Azure DevOps",
    async prepare(change) {
      const owner = await authenticatedAzureOwner(client);
      return { client, change, ownerUniqueName: owner.uniqueName };
    },
    async assertCurrent(prepared, expectedHeadSha) {
      await assertCurrentAzurePullRequest(client, prepared.change, expectedHeadSha);
    },
    async loadOwnedState(prepared): Promise<LoadedPublicationState> {
      const coordinates = azureCoordinates(prepared.change);
      const threads = await client.listThreads(
        coordinates.repositoryId,
        prepared.change.change.number,
      );
      const main = ownedAzureRootThread(
        threads,
        prepared.ownerUniqueName,
        azureMainMarker(prepared.change.change.number),
      );
      return {
        main: main?.comments[0]
          ? { id: main.comments[0].id, body: main.comments[0].content }
          : undefined,
        inline: threads.flatMap((thread) => {
          const root = thread.comments[0];
          if (!root || root.author?.uniqueName !== prepared.ownerUniqueName) return [];
          return [
            {
              body: root.content,
              location: azureInlineLocationFromThread(thread),
              resolved: isAzureThreadResolved(thread),
            },
          ];
        }),
        threads: azureThreadContexts(threads, prepared.ownerUniqueName),
      };
    },
    async upsertMain(prepared, existing, body) {
      const coordinates = azureCoordinates(prepared.change);
      if (existing) {
        const threads = await client.listThreads(
          coordinates.repositoryId,
          prepared.change.change.number,
        );
        const thread = threads.find((candidate) => candidate.comments[0]?.id === existing.id);
        if (!thread) throw new Error("Azure DevOps Main Review Comment thread was not found");
        const comment = await client.updateComment(
          coordinates.repositoryId,
          prepared.change.change.number,
          thread.id,
          existing.id,
          body,
        );
        return { id: comment.id, action: "updated" };
      }
      const comment = (
        await client.createThread(
          coordinates.repositoryId,
          prepared.change.change.number,
          unpositionedAzureThread(body),
        )
      ).comments[0];
      if (!comment) throw new Error("Azure DevOps did not return the Main Review Comment");
      return { id: comment.id, action: "created" };
    },
    inlineLocation: (_prepared, item) => azureInlineLocation(item),
    async createInline(prepared, item: InlinePublicationItem) {
      const coordinates = azureCoordinates(prepared.change);
      if (!prepared.iterationId) {
        prepared.iterationId = (
          await currentAzureNativeChange(client, prepared.change, item.reviewedHeadSha)
        ).iterationId;
      }
      prepared.changes ??= await client.listIterationChanges(
        coordinates.repositoryId,
        prepared.change.change.number,
        prepared.iterationId,
      );
      await client.createThread(
        coordinates.repositoryId,
        prepared.change.change.number,
        await azureInlineThread(prepared.change, item, prepared.changes, prepared.iterationId),
      );
    },
    async loadOwnedCommand(prepared, marker) {
      const coordinates = azureCoordinates(prepared.change);
      const threads = await client.listThreads(
        coordinates.repositoryId,
        prepared.change.change.number,
      );
      const thread = ownedAzureRootThread(threads, prepared.ownerUniqueName, marker);
      const comment = thread?.comments[0];
      return comment ? { id: comment.id, body: comment.content } : undefined;
    },
    async upsertCommand(prepared, existing, body) {
      const coordinates = azureCoordinates(prepared.change);
      if (existing) {
        const threads = await client.listThreads(
          coordinates.repositoryId,
          prepared.change.change.number,
        );
        const thread = threads.find((candidate) => candidate.comments[0]?.id === existing.id);
        if (!thread) throw new Error("Azure DevOps command response thread was not found");
        const comment = await client.updateComment(
          coordinates.repositoryId,
          prepared.change.change.number,
          thread.id,
          existing.id,
          body,
        );
        return { id: comment.id, action: "updated" };
      }
      const comment = (
        await client.createThread(
          coordinates.repositoryId,
          prepared.change.change.number,
          unpositionedAzureThread(body),
        )
      ).comments[0];
      if (!comment) throw new Error("Azure DevOps did not return the command response comment");
      return { id: comment.id, action: "created" };
    },
    async replyThread(prepared, action, body) {
      const coordinates = azureCoordinates(prepared.change);
      const thread = await findThread(prepared, action.threadId, action.commentId);
      if (!thread) throw new Error(`Azure DevOps thread not found for comment ${action.commentId}`);
      await client.createThreadComment(
        coordinates.repositoryId,
        prepared.change.change.number,
        thread.id,
        { parentCommentId: Number(thread.comments[0]?.id ?? 0), content: body, commentType: 1 },
      );
    },
    async resolveThread(prepared, action) {
      const coordinates = azureCoordinates(prepared.change);
      const thread = await findThread(prepared, action.threadId, action.commentId);
      if (!thread) throw new Error(`Azure DevOps thread not found for comment ${action.commentId}`);
      await client.updateThreadStatus(
        coordinates.repositoryId,
        prepared.change.change.number,
        thread.id,
        "fixed",
      );
    },
  };
}

function azureThreadContexts(threads: AzureDevOpsThread[], owner: string) {
  return threads.flatMap((thread) => {
    const root = thread.comments[0];
    const marker = root ? extractInlineFindingMarkerRecords([root.content])[0] : undefined;
    if (!root || !marker || root.author?.uniqueName !== owner) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.content,
        threadId: thread.id,
        threadResolved: isAzureThreadResolved(thread),
        comments: thread.comments.flatMap((comment) =>
          comment.author?.uniqueName === owner
            ? [{ id: comment.id, body: comment.content, authorLogin: comment.author.uniqueName }]
            : [],
        ),
      },
    ];
  });
}

async function findThread(prepared: Prepared, threadId: string | undefined, commentId: string) {
  const threads = await prepared.client.listThreads(
    azureCoordinates(prepared.change).repositoryId,
    prepared.change.change.number,
  );
  return threadId
    ? threads.find((thread) => thread.id === threadId)
    : threads.find((thread) => thread.comments.some((comment) => comment.id === commentId));
}
