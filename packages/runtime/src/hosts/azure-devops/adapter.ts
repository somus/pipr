import { retryCodeHostOperation } from "../retry.js";
import type { CodeHostAdapter } from "../types.js";
import {
  type AzureDevOpsClient,
  azureDevOpsStatusState,
  createAzureDevOpsClient,
} from "./client.js";
import { parseAzureDevOpsEvent } from "./event.js";
import {
  loadAzureDevOpsInlineThreadContexts,
  loadAzureDevOpsPriorMainComment,
  loadAzureDevOpsPriorReviewState,
  publishAzureDevOpsCommandResponse,
  publishAzureDevOpsPlan,
  publishAzureDevOpsThreadActions,
} from "./publication.js";
import { ensureAzureDevOpsHeadCheckout } from "./workspace.js";

export function createAzureDevOpsHostAdapter(
  options: { env?: NodeJS.ProcessEnv; client?: AzureDevOpsClient } = {},
): CodeHostAdapter {
  const client = options.client ?? createAzureDevOpsClient(options.env);
  return {
    id: "azure-devops",
    capabilities: {
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: true,
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
          .then((loaded) => ({
            ...loaded,
            eventName: ref.eventName,
            action: ref.action,
            rawAction: ref.rawAction,
            workspace: ref.workspace,
          }));
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
    publication: {
      publish: ({ plan, change }) => publishAzureDevOpsPlan({ client, plan, change }),
      publishCommandResponse: (args) => publishAzureDevOpsCommandResponse({ client, ...args }),
      publishThreadActions: (args) => publishAzureDevOpsThreadActions({ client, ...args }),
    },
    comments: {
      loadPriorReviewState: ({ change }) => loadAzureDevOpsPriorReviewState({ client, change }),
      loadPriorMainComment: ({ change }) => loadAzureDevOpsPriorMainComment({ client, change }),
      loadInlineThreadContexts: ({ change }) =>
        loadAzureDevOpsInlineThreadContexts({ client, change }),
    },
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        const coordinates = azureCoordinates(change);
        const pullRequest = await client.getPullRequest(
          coordinates.repositoryId,
          change.change.number,
        );
        if (
          pullRequest.lastMergeSourceCommit.commitId !== change.change.head.sha ||
          pullRequest.lastMergeTargetCommit.commitId !== change.change.base.sha
        ) {
          throw new Error("Azure DevOps pull request endpoints changed before status publication");
        }
        const iterations = await client.listIterations(
          coordinates.repositoryId,
          change.change.number,
        );
        const iteration = iterations.findLast(
          (candidate) => candidate.headSha === change.change.head.sha,
        );
        if (!iteration) {
          throw new Error(
            `Azure DevOps has no pull request iteration for head ${change.change.head.sha}`,
          );
        }
        const id = await retryCodeHostOperation({
          idempotent: true,
          operation: () =>
            client.createStatus(coordinates.repositoryId, change.change.number, {
              state: azureDevOpsStatusState(state),
              description: summary?.slice(0, 1_000),
              context: { genre: "pipr", name: `pipr/${name}` },
              iterationId: iteration.id,
            }),
        });
        return status ?? { id, name };
      },
    },
  };
}

function azureCoordinates(
  change: Parameters<NonNullable<CodeHostAdapter["statuses"]>["upsert"]>[0]["change"],
) {
  if (change.coordinates?.provider !== "azure-devops") {
    throw new Error("Azure DevOps adapter requires Azure DevOps coordinates");
  }
  return change.coordinates;
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
