import { githubCoordinates } from "../../shared/github.js";
import { retryCodeHostOperation } from "../retry.js";
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
        const change = await loadGitHubPullRequestEventContext(eventOptions);
        return change.change.isDraft
          ? { kind: "ignored", reason: "pull request is a draft" }
          : { kind: "change-request", change };
      },
      async loadChangeRequest(ref) {
        const loaded = await commandClient.getPullRequest({
          repository: ref.repository,
          changeNumber: ref.changeNumber,
        });
        return {
          ...loaded,
          coordinates: githubCoordinates(loaded.repository.slug),
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
      getRepositoryPermission({ change, actor }) {
        return commandClient.getRepositoryPermission({ repository: change.repository, actor });
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
      isAvailable(change) {
        return change.eventName === "pull_request";
      },
      async upsert(options) {
        if (!options.status) {
          const externalId = githubStatusExternalId(options);
          const existing = (
            await publicationClient.listCheckRuns({
              repo: options.change.repository.slug,
              headSha: options.change.change.head.sha,
            })
          ).find((check) => check.externalId === externalId);
          const checkRun =
            existing ??
            (await retryCodeHostOperation({
              operation: () =>
                publicationClient.createCheckRun({
                  repo: options.change.repository.slug,
                  name: options.name,
                  headSha: options.change.change.head.sha,
                  externalId,
                  summary: options.summary,
                }),
              reconcile: async () =>
                (
                  await publicationClient.listCheckRuns({
                    repo: options.change.repository.slug,
                    headSha: options.change.change.head.sha,
                  })
                ).find((check) => check.externalId === externalId),
            }));
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

function githubStatusExternalId(
  options: Parameters<NonNullable<CodeHostAdapter["statuses"]>["upsert"]>[0],
): string {
  const identity = [
    options.change.change.number,
    options.change.change.head.sha,
    options.name,
  ].join("\0");
  return `pipr:${new Bun.CryptoHasher("sha256").update(identity).digest("hex")}`;
}
