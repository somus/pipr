import type { CodeHostAdapter } from "../types.js";
import { createGitHubCommandClient, type GitHubCommandClient } from "./command.js";
import {
  loadGitHubIssueCommentEventContext,
  loadGitHubPullRequestEventContext,
  loadGitHubReviewCommentReplyEvent,
} from "./event.js";
import {
  createGitHubPublicationClient,
  type GitHubPublicationClient,
  loadGitHubInlineThreadContexts,
  loadGitHubPriorMainComment,
  loadGitHubPriorReviewState,
  publishGitHubCommandResponse,
  publishGitHubPublicationPlan,
  publishGitHubThreadActions,
} from "./publication.js";
import { ensureGitHubHeadCheckout, ensureGitHubWorkspaceSafeDirectory } from "./workspace.js";

export type GitHubHostAdapterOptions = {
  env?: NodeJS.ProcessEnv;
  commandClient?: GitHubCommandClient;
  publicationClient?: GitHubPublicationClient;
};

export function createGitHubHostAdapter(options: GitHubHostAdapterOptions = {}): CodeHostAdapter {
  const env = options.env ?? process.env;
  const commandClient = options.commandClient ?? createGitHubCommandClient(env);
  const publicationClient = options.publicationClient ?? createGitHubPublicationClient(env);

  return {
    id: "github",
    capabilities: {
      commandComments: true,
      reviewCommentReplies: true,
      threadResolution: true,
      multilineInlineComments: true,
      suggestedChanges: true,
      statuses: true,
    },
    events: {
      async parseEvent(parseOptions) {
        const eventPath = parseOptions.eventPath;
        if (!eventPath) {
          throw new Error("GITHUB_EVENT_PATH is required for GitHub events");
        }
        const eventOptions = { ...parseOptions, eventPath };
        if (parseOptions.env.GITHUB_EVENT_NAME === "issue_comment") {
          return {
            kind: "command-comment",
            comment: await loadGitHubIssueCommentEventContext(eventOptions),
          };
        }
        if (parseOptions.env.GITHUB_EVENT_NAME === "pull_request_review_comment") {
          return {
            kind: "review-comment-reply",
            reply: await loadGitHubReviewCommentReplyEvent(eventOptions),
          };
        }
        return {
          kind: "change-request",
          change: await loadGitHubPullRequestEventContext(eventOptions),
        };
      },
      async loadChangeRequest(ref) {
        const loaded = await commandClient.getPullRequest({
          repository: ref.repository,
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
    workspace: {
      ensureHeadCheckout: ensureGitHubHeadCheckout,
      ensureWorkspaceSafeDirectory: ensureGitHubWorkspaceSafeDirectory,
    },
    permissions: {
      getRepositoryPermission(options) {
        return commandClient.getRepositoryPermission(options);
      },
    },
    publication: {
      publish(options) {
        return publishGitHubPublicationPlan({
          client: publicationClient,
          change: options.change,
          plan: options.plan,
        });
      },
      publishCommandResponse(options) {
        return publishGitHubCommandResponse({
          client: publicationClient,
          change: options.change,
          sourceCommentId: Number(options.sourceCommentId),
          commandName: options.commandName,
          body: options.body,
        });
      },
      publishThreadActions(options) {
        return publishGitHubThreadActions({
          client: publicationClient,
          change: options.change,
          actions: options.actions,
          reviewedHeadSha: options.reviewedHeadSha,
        });
      },
    },
    comments: {
      loadPriorReviewState(options) {
        return loadGitHubPriorReviewState({
          client: publicationClient,
          change: options.change,
        });
      },
      loadPriorMainComment(options) {
        return loadGitHubPriorMainComment({
          client: publicationClient,
          change: options.change,
        });
      },
      loadInlineThreadContexts(options) {
        return loadGitHubInlineThreadContexts({
          client: publicationClient,
          change: options.change,
        });
      },
    },
    statuses: {
      async upsert(options) {
        if (!options.status) {
          const checkRun = await publicationClient.createCheckRun({
            repo: options.change.repository.slug,
            name: options.name,
            headSha: options.change.change.head.sha,
            summary: options.summary,
          });
          return { id: String(checkRun.id), name: checkRun.name };
        }
        if (options.state === "pending") {
          return options.status;
        }
        await publicationClient.updateCheckRun({
          repo: options.change.repository.slug,
          checkRunId: Number(options.status.id),
          name: options.status.name,
          conclusion: options.state,
          summary: options.summary,
        });
        return options.status;
      },
    },
  };
}
