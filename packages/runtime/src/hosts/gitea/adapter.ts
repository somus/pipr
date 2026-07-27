import { commandStatusText } from "../publication.js";
import type { CodeHostAdapter } from "../types.js";
import { createGiteaClient, type GiteaClient, type GiteaFamilyHost } from "./client.js";
import { parseGiteaEvent } from "./event.js";
import {
  assertCurrentGiteaHead,
  giteaCoordinates,
  loadGiteaInlineThreadContexts,
  loadGiteaPriorMainComment,
  loadGiteaPriorReviewState,
  publishGiteaCommandResponse,
  publishGiteaPlan,
  publishGiteaReviewProgress,
  publishGiteaThreadActions,
} from "./publication.js";
import { ensureGiteaHeadCheckout } from "./workspace.js";

export function createGiteaHostAdapter(options: {
  host: GiteaFamilyHost;
  env?: NodeJS.ProcessEnv;
  client?: GiteaClient;
}): CodeHostAdapter {
  const client = options.client ?? createGiteaClient({ host: options.host, env: options.env });
  return {
    id: options.host,
    capabilities: {
      commandComments: true,
      reviewCommentReplies: false,
      threadResolution: false,
      multilineInlineComments: false,
      suggestedChanges: false,
      statuses: true,
    },
    events: {
      parseEvent: (parseOptions) =>
        parseGiteaEvent({
          ...parseOptions,
          host: options.host,
          loadChangeRequest: (ref) => client.loadChange(ref),
        }),
      async loadChangeRequest(ref) {
        const coordinates = coordinatesFromSlug(ref.repository.slug);
        const loaded = await client.loadChange({
          ...coordinates,
          changeNumber: ref.changeNumber,
        });
        return {
          ...loaded,
          eventName: ref.eventName,
          action: ref.action,
          rawAction: ref.rawAction,
          workspace: ref.workspace,
        };
      },
    },
    workspace: { ensureHeadCheckout: ensureGiteaHeadCheckout },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        const coordinates = giteaCoordinates(change);
        return client.getRepositoryPermission(coordinates.owner, coordinates.repository, actor);
      },
    },
    publication: {
      publish: ({ change, plan, progressLease }) =>
        publishGiteaPlan({ client, change, plan, progressLease }),
      publishReviewProgress: (args) => publishGiteaReviewProgress({ client, ...args }),
      publishCommandResponse: (args) => publishGiteaCommandResponse({ client, ...args }),
      publishCommandStatus: (args) =>
        publishGiteaCommandResponse({
          client,
          ...args,
          body: commandStatusText(args),
          allowHeadDrift: true,
        }),
      publishThreadActions: (args) => publishGiteaThreadActions({ client, ...args }),
    },
    comments: {
      loadPriorReviewState: ({ change }) => loadGiteaPriorReviewState({ client, change }),
      loadPriorMainComment: ({ change }) => loadGiteaPriorMainComment({ client, change }),
      loadInlineThreadContexts: ({ change }) => loadGiteaInlineThreadContexts({ client, change }),
    },
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        await assertCurrentGiteaHead(client, change, change.change.head.sha);
        const coordinates = giteaCoordinates(change);
        const id = await client.setStatus(
          coordinates.owner,
          coordinates.repository,
          change.change.head.sha,
          name,
          state,
          summary,
        );
        return status ?? { id, name };
      },
    },
  };
}

function coordinatesFromSlug(slug: string): { owner: string; repository: string } {
  const parts = slug.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error(`Invalid Gitea-compatible repository slug '${slug}'`);
  }
  return { owner: parts[0] ?? "", repository: parts[1] ?? "" };
}
