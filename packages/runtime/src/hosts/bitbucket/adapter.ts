import type { CodeHostAdapter } from "../types.js";
import { type BitbucketClient, bitbucketStatusState, createBitbucketClient } from "./client.js";
import { parseBitbucketEvent } from "./event.js";
import {
  loadBitbucketInlineThreadContexts,
  loadBitbucketPriorMainComment,
  loadBitbucketPriorReviewState,
  publishBitbucketCommandResponse,
  publishBitbucketPlan,
  publishBitbucketThreadActions,
} from "./publication.js";
import { ensureBitbucketHeadCheckout } from "./workspace.js";

export function createBitbucketHostAdapter(
  options: { env?: NodeJS.ProcessEnv; client?: BitbucketClient } = {},
): CodeHostAdapter {
  const client = options.client ?? createBitbucketClient(options.env);
  return {
    id: "bitbucket",
    capabilities: {
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: false,
      statuses: true,
    },
    events: {
      parseEvent: (parseOptions) =>
        parseBitbucketEvent({
          ...parseOptions,
          loadChangeRequest: (ref) => client.loadChange(ref),
        }),
      loadChangeRequest(ref) {
        const parts = ref.repository.slug.split("/");
        return client
          .loadChange({
            workspace: parts.at(-2) ?? client.workspace,
            repository: parts.at(-1) ?? client.repository,
            changeNumber: ref.changeNumber,
          })
          .then((loaded) => ({
            ...loaded,
            eventName: ref.eventName,
            action: ref.action,
            rawAction: ref.rawAction,
            workspace: ref.workspace,
          }));
      },
    },
    workspace: { ensureHeadCheckout: ensureBitbucketHeadCheckout },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        const coordinates = bitbucketCoordinates(change);
        if (!coordinates.repositoryUuid)
          throw new Error("Bitbucket repository UUID is required for permission checks");
        return client.getRepositoryPermission(actor, coordinates.repositoryUuid);
      },
    },
    publication: {
      publish: ({ change, plan }) => publishBitbucketPlan({ client, change, plan }),
      publishCommandResponse: (args) => publishBitbucketCommandResponse({ client, ...args }),
      publishThreadActions: (args) => publishBitbucketThreadActions({ client, ...args }),
    },
    comments: {
      loadPriorReviewState: ({ change }) => loadBitbucketPriorReviewState({ client, change }),
      loadPriorMainComment: ({ change }) => loadBitbucketPriorMainComment({ client, change }),
      loadInlineThreadContexts: ({ change }) =>
        loadBitbucketInlineThreadContexts({ client, change }),
    },
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        const pullRequest = await client.getPullRequest(change.change.number);
        if (
          pullRequest.source.commit.hash !== change.change.head.sha ||
          pullRequest.destination.commit.hash !== change.change.base.sha
        )
          throw new Error("Bitbucket pull request endpoints changed before status publication");
        const key = `pipr-${name}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
        const id = await client.setStatus(change.change.head.sha, key, {
          state: bitbucketStatusState(state),
          key,
          name: `Pipr: ${name}`.slice(0, 255),
          description: summary?.slice(0, 255),
          refname: change.change.head.ref,
          url: change.change.url,
        });
        return status ?? { id, name };
      },
    },
  };
}

function bitbucketCoordinates(
  change: Parameters<NonNullable<CodeHostAdapter["statuses"]>["upsert"]>[0]["change"],
) {
  if (change.coordinates?.provider !== "bitbucket")
    throw new Error("Bitbucket adapter requires Bitbucket coordinates");
  return change.coordinates;
}
