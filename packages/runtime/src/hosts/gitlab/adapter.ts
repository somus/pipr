import { withEventRef } from "../change-request.js";
import { createPublicationWorkflow } from "../publication/workflow.js";
import type { CodeHostAdapter } from "../types.js";
import { createGitLabClient, type GitLabClient } from "./client.js";
import { parseGitLabEvent } from "./event.js";
import {
  gitLabCoordinates,
  loadGitLabInlineThreadContexts,
  loadGitLabPriorMainComment,
  loadGitLabPriorReviewState,
} from "./publication.js";
import { createGitLabPublicationDriver } from "./publication-driver.js";
import { ensureGitLabHeadCheckout } from "./workspace.js";

export function createGitLabHostAdapter(
  options: { env?: NodeJS.ProcessEnv; client?: GitLabClient } = {},
): CodeHostAdapter {
  const client = options.client ?? createGitLabClient(options.env);
  const publication = createPublicationWorkflow(createGitLabPublicationDriver(client));
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
        return client
          .loadChange({
            ...gitLabProject(ref.repository.slug, ref.repository.url),
            changeNumber: ref.changeNumber,
          })
          .then((loaded) => withEventRef(loaded, ref));
      },
    },
    workspace: { ensureHeadCheckout: ensureGitLabHeadCheckout },
    permissions: {
      getRepositoryPermission({ change, actor }) {
        return client.getRepositoryPermission(
          gitLabProject(change.repository.slug, change.repository.url).projectId,
          actor,
        );
      },
    },
    publication,
    comments: {
      loadPriorReviewState: ({ change }) => loadGitLabPriorReviewState({ client, change }),
      loadPriorMainComment: ({ change }) => loadGitLabPriorMainComment({ client, change }),
      loadInlineThreadContexts: ({ change }) => loadGitLabInlineThreadContexts({ client, change }),
    },
    statuses: {
      isAvailable: () => true,
      async upsert({ change, name, state, summary, status }) {
        const id = await client.setStatus(
          gitLabCoordinates(change).projectId,
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

function gitLabProject(slug: string, url: string | undefined) {
  const projectId = url?.match(/\/projects\/(\d+)/)?.[1] ?? slug;
  return { projectId, projectPath: slug };
}
