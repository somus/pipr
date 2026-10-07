import type { InlinePublicationItem } from "../../publication/types.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type {
  LoadedPublicationState,
  OwnedMainComment,
  PublicationDriver,
} from "../publication/workflow.js";
import { mainCommentPrefix, planInlineLocation } from "../publication.js";
import type { AzureDevOpsClient, AzureDevOpsIterationChange, AzureDevOpsThread } from "./client.js";
import {
  authenticatedAzureOwner,
  azureCoordinates,
  azureDevOpsProvider,
  azureInlineLocationFromThread,
  azureInlineThread,
  azureThreadContexts,
  currentAzureEndpoints,
  currentAzureIterationId,
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
    provider: azureDevOpsProvider,
    async prepare(change) {
      const owner = await authenticatedAzureOwner(client);
      return { client, change, ownerUniqueName: owner.uniqueName };
    },
    currentEndpoints: (prepared) => currentAzureEndpoints(client, prepared.change),
    async loadOwnedState(prepared, _mainMarker, options): Promise<LoadedPublicationState> {
      const threads = await loadAzureThreads(client, prepared);
      return {
        main: azureOwnedMain(threads, prepared),
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
        threads: azureThreadContexts(threads, prepared.ownerUniqueName, !options?.allReplies),
      };
    },
    async loadOwnedMain(prepared) {
      return azureOwnedMain(await loadAzureThreads(client, prepared), prepared);
    },
    upsertComment: (prepared, existing, body, kind) =>
      upsertAzureRootComment(
        client,
        prepared,
        existing,
        body,
        kind === "main" ? "Main Review Comment" : "command response comment",
      ),
    inlineLocation: (_prepared, item) => planInlineLocation(item),
    async createInline(prepared, item: InlinePublicationItem) {
      const coordinates = azureCoordinates(prepared.change);
      if (!prepared.iterationId) {
        prepared.iterationId = await currentAzureIterationId(
          client,
          prepared.change,
          item.reviewedHeadSha,
        );
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

function loadAzureThreads(client: AzureDevOpsClient, prepared: Prepared) {
  const coordinates = azureCoordinates(prepared.change);
  return client.listThreads(coordinates.repositoryId, prepared.change.change.number);
}

function azureOwnedMain(threads: AzureDevOpsThread[], prepared: Prepared) {
  const main = ownedAzureRootThread(
    threads,
    prepared.ownerUniqueName,
    mainCommentPrefix(prepared.change.change.number),
  )?.comments[0];
  return main ? { id: main.id, body: main.content } : undefined;
}

async function upsertAzureRootComment(
  client: AzureDevOpsClient,
  prepared: Prepared,
  existing: OwnedMainComment | undefined,
  body: string,
  description: string,
) {
  const coordinates = azureCoordinates(prepared.change);
  if (existing) {
    const threads = await client.listThreads(
      coordinates.repositoryId,
      prepared.change.change.number,
    );
    const thread = threads.find((candidate) => candidate.comments[0]?.id === existing.id);
    if (!thread) throw new Error(`Azure DevOps ${description} thread was not found`);
    const comment = await client.updateComment(
      coordinates.repositoryId,
      prepared.change.change.number,
      thread.id,
      existing.id,
      body,
    );
    return { id: comment.id, action: "updated" as const };
  }
  const comment = (
    await client.createThread(
      coordinates.repositoryId,
      prepared.change.change.number,
      unpositionedAzureThread(body),
    )
  ).comments[0];
  if (!comment) throw new Error(`Azure DevOps did not return the ${description}`);
  return { id: comment.id, action: "created" as const };
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
