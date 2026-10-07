import { withEventRef } from "../change-request.js";
import { createCommentsReader, createPublicationWorkflow } from "../publication/workflow.js";
import type { CodeHostAdapter } from "../types.js";
import {
  createGiteaClient,
  type GiteaClient,
  type GiteaFamilyHost,
  parseGiteaRepositorySlug,
} from "./client.js";
import { parseGiteaEvent } from "./event.js";
import { assertCurrentGiteaHead, giteaCoordinates } from "./publication.js";
import { createGiteaPublicationDriver } from "./publication-driver.js";
import { ensureGiteaHeadCheckout } from "./workspace.js";

export function createGiteaHostAdapter(options: {
  host: GiteaFamilyHost;
  env?: NodeJS.ProcessEnv;
  client?: GiteaClient;
}): CodeHostAdapter {
  const client = options.client ?? createGiteaClient({ host: options.host, env: options.env });
  const driver = createGiteaPublicationDriver(client);
  const publication = createPublicationWorkflow(driver);
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
        const loaded = await client.loadChange({
          ...parseGiteaRepositorySlug(ref.repository.slug),
          changeNumber: ref.changeNumber,
        });
        return withEventRef(loaded, ref);
      },
    },
    workspace: { ensureHeadCheckout: ensureGiteaHeadCheckout },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        const coordinates = giteaCoordinates(change);
        return client.getRepositoryPermission(coordinates.owner, coordinates.repository, actor);
      },
    },
    publication,
    comments: createCommentsReader(driver),
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
