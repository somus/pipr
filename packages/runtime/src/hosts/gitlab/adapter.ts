import { commandStatusText } from "../publication.js";
import type { CodeHostAdapter } from "../types.js";
import { createGitLabClient, type GitLabClient } from "./client.js";
import { parseGitLabEvent } from "./event.js";
import {
  loadGitLabInlineThreadContexts,
  loadGitLabPriorMainComment,
  loadGitLabPriorReviewState,
  publishGitLabCommandResponse,
  publishGitLabPlan,
  publishGitLabThreadActions,
} from "./publication.js";
import { ensureGitLabHeadCheckout } from "./workspace.js";

export function createGitLabHostAdapter(
  options: { env?: NodeJS.ProcessEnv; client?: GitLabClient } = {},
): CodeHostAdapter {
  const client = options.client ?? createGitLabClient(options.env);
  return {
    id: "gitlab",
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
        return parseGitLabEvent({
          ...parseOptions,
          loadChangeRequest: (ref) => client.loadChange(ref),
          resolveReplyParent: ({ projectId, changeNumber, noteId, discussionId }) =>
            client.findReplyParent(projectId, changeNumber, noteId, discussionId),
        });
      },
      loadChangeRequest(ref) {
        const coordinates = gitLabCoordinates(ref.repository.slug, ref.repository.url);
        return client
          .loadChange({
            projectId: coordinates.projectId,
            projectPath: coordinates.projectPath,
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
    workspace: { ensureHeadCheckout: ensureGitLabHeadCheckout },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        return client.getRepositoryPermission(
          gitLabCoordinates(change.repository.slug, change.repository.url).projectId,
          actor,
        );
      },
    },
    publication: {
      publish: ({ plan, change }) => publishGitLabPlan({ client, plan, change }),
      publishCommandResponse: (args) => publishGitLabCommandResponse({ client, ...args }),
      publishCommandStatus: (args) =>
        publishGitLabCommandResponse({
          client,
          ...args,
          body: commandStatusText(args),
          allowHeadDrift: true,
        }),
      publishThreadActions: (args) => publishGitLabThreadActions({ client, ...args }),
    },
    comments: {
      loadPriorReviewState: ({ change }) => loadGitLabPriorReviewState({ client, change }),
      loadPriorMainComment: ({ change }) => loadGitLabPriorMainComment({ client, change }),
      loadInlineThreadContexts: ({ change }) => loadGitLabInlineThreadContexts({ client, change }),
    },
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        const id = await client.setStatus(
          gitLabChangeCoordinates(change).projectId,
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

function gitLabChangeCoordinates(
  change: Parameters<NonNullable<CodeHostAdapter["statuses"]>["upsert"]>[0]["change"],
) {
  if (change.coordinates?.provider !== "gitlab") {
    throw new Error("GitLab adapter requires GitLab coordinates");
  }
  return change.coordinates;
}

function gitLabCoordinates(slug: string, url: string | undefined) {
  const projectId = url?.match(/\/projects\/(\d+)/)?.[1] ?? slug;
  return { projectId, projectPath: slug };
}
