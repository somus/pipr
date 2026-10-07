import { withEventRef } from "../change-request.js";
import { createPublicationWorkflow } from "../publication/workflow.js";
import type { CodeHostAdapter } from "../types.js";
import {
  type AzureDevOpsClient,
  azureDevOpsStatusState,
  createAzureDevOpsClient,
} from "./client.js";
import { parseAzureDevOpsEvent } from "./event.js";
import {
  azureCoordinates,
  currentAzureNativeChange,
  loadAzureDevOpsInlineThreadContexts,
  loadAzureDevOpsPriorMainComment,
  loadAzureDevOpsPriorReviewState,
} from "./publication.js";
import { createAzureDevOpsPublicationDriver } from "./publication-driver.js";
import { ensureAzureDevOpsHeadCheckout } from "./workspace.js";

export function createAzureDevOpsHostAdapter(
  options: { env?: NodeJS.ProcessEnv; client?: AzureDevOpsClient } = {},
): CodeHostAdapter {
  const client = options.client ?? createAzureDevOpsClient(options.env);
  const publication = createPublicationWorkflow(createAzureDevOpsPublicationDriver(client));
  return {
    id: "azure-devops",
    capabilities: {
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: false,
      statuses: true,
    },
    events: {
      parseEvent(parseOptions) {
        return parseAzureDevOpsEvent({
          ...parseOptions,
          loadChangeRequest: (ref) => client.loadChange(ref),
        });
      },
      loadChangeRequest(ref) {
        const coordinates = azureCoordinatesFromRepository(client, ref.repository.slug);
        return client
          .loadChange({ ...coordinates, changeNumber: ref.changeNumber })
          .then((loaded) => withEventRef(loaded, ref));
      },
    },
    workspace: { ensureHeadCheckout: ensureAzureDevOpsHeadCheckout },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        const coordinates = azureCoordinates(change);
        if (!coordinates.projectId)
          throw new Error("Azure DevOps projectId is required for permission checks");
        return client.getRepositoryPermission(
          actor,
          coordinates.projectId,
          coordinates.repositoryId,
        );
      },
    },
    publication,
    comments: {
      loadPriorReviewState: ({ change }) => loadAzureDevOpsPriorReviewState({ client, change }),
      loadPriorMainComment: ({ change }) => loadAzureDevOpsPriorMainComment({ client, change }),
      loadInlineThreadContexts: ({ change }) =>
        loadAzureDevOpsInlineThreadContexts({ client, change }),
    },
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        const { iterationId } = await currentAzureNativeChange(
          client,
          change,
          change.change.head.sha,
          "Azure DevOps pull request endpoints changed before status publication",
        );
        const id = await client.createStatus(
          azureCoordinates(change).repositoryId,
          change.change.number,
          {
            state: azureDevOpsStatusState(state),
            description: summary?.slice(0, 1_000),
            context: { genre: "pipr", name: `pipr/${name}` },
            iterationId,
          },
        );
        return status ?? { id, name };
      },
    },
  };
}

function azureCoordinatesFromRepository(client: AzureDevOpsClient, slug: string) {
  const parts = slug.split("/");
  const repositoryId = parts.at(-1);
  if (!repositoryId) throw new Error("Azure DevOps repository slug must identify a repository");
  return {
    organization: client.organization,
    project: client.project,
    repositoryId,
  };
}
