import { requireCoordinates, withEventRef } from "../change-request.js";
import {
  assertEndpointsCurrent,
  createCommentsReader,
  createPublicationWorkflow,
} from "../publication/workflow.js";
import type { CodeHostAdapter } from "../types.js";
import { bitbucketStatusState, createBitbucketClient } from "./client.js";
import { parseBitbucketEvent } from "./event.js";
import type { BitbucketClient } from "./models.js";
import { currentBitbucketEndpoints } from "./publication.js";
import { createBitbucketPublicationDriver } from "./publication-driver.js";
import { ensureBitbucketHeadCheckout } from "./workspace.js";

export function createBitbucketHostAdapter(
  options: { env?: NodeJS.ProcessEnv; client?: BitbucketClient } = {},
): CodeHostAdapter {
  const client = options.client ?? createBitbucketClient(options.env);
  const driver = createBitbucketPublicationDriver(client);
  const publication = createPublicationWorkflow(driver);
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
          .then((loaded) => withEventRef(loaded, ref));
      },
    },
    workspace: {
      ensureHeadCheckout: (args) => ensureBitbucketHeadCheckout({ ...args, env: options.env }),
    },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        const coordinates = requireCoordinates(change, "bitbucket", "Bitbucket");
        if (!coordinates.repositoryUuid)
          throw new Error("Bitbucket repository UUID is required for permission checks");
        return client.getRepositoryPermission(actor, coordinates.repositoryUuid);
      },
    },
    publication,
    comments: createCommentsReader(driver),
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        const current = await currentBitbucketEndpoints(client, change);
        assertEndpointsCurrent(driver.provider, current, change, { stage: "status publication" });
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
