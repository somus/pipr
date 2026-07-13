import type { PublicationPlan } from "../../review/comment.js";
import {
  extractResolvedFindingMarkerRecords,
  extractVerifierResponseMarkers,
} from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { threadActionReply } from "../publication.js";
import type {
  GitHubPublicationClient,
  GitHubReviewComment,
  GitHubReviewThread,
} from "./publication-client.js";
import {
  assertCurrentHeadSha,
  listOwnedReviewComments,
  reviewThreadByCommentId,
} from "./publication-shared.js";

export async function publishGitHubThreadActions(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  actions: PublicationPlan["threadActions"];
  reviewedHeadSha: string;
}): Promise<{ errors: string[] }> {
  if (options.actions.length === 0) {
    return { errors: [] };
  }
  await assertCurrentHeadSha(options.client, options.change, options.reviewedHeadSha);
  const ownerLogin = await options.client.getAuthenticatedUserLogin();
  const existingReviewComments = await listOwnedReviewComments({ ...options, ownerLogin });
  await assertCurrentHeadSha(options.client, options.change, options.reviewedHeadSha);
  return await publishGitHubPublicationThreadActions({ ...options, existingReviewComments });
}

export async function publishGitHubPublicationThreadActions(options: {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  actions?: PublicationPlan["threadActions"];
  plan?: PublicationPlan;
  reviewedHeadSha?: string;
  existingReviewComments: GitHubReviewComment[];
}): Promise<{ errors: string[] }> {
  const actions = options.actions ?? options.plan?.threadActions ?? [];
  if (actions.length === 0) {
    return { errors: [] };
  }
  const context: ThreadActionContext = {
    client: options.client,
    change: options.change,
    reviewedHeadSha: threadActionHeadSha(options),
    resolvedKeys: new Set(
      extractResolvedFindingMarkerRecords(
        options.existingReviewComments.map((comment) => comment.body ?? ""),
      ).map((record) => `${record.id}:${record.head}`),
    ),
    responseMarkers: extractVerifierResponseMarkers(
      options.existingReviewComments.map((comment) => comment.body ?? ""),
    ),
    threadById: new Map<string, GitHubReviewThread>(),
    threadByCommentId: new Map<number, GitHubReviewThread>(),
  };
  const errors: string[] = [];
  const threadLoad = await loadThreadActionThreads(context, actions);
  context.threadById = threadLoad.threads;
  context.threadByCommentId = threadLoad.threadsByCommentId;
  if (threadLoad.error) {
    errors.push(threadLoad.error);
  }
  await assertCurrentHeadSha(options.client, options.change, context.reviewedHeadSha);
  for (const action of actions) {
    errors.push(...(await publishThreadAction(context, action)));
  }
  return { errors };
}

function threadActionHeadSha(options: {
  plan?: PublicationPlan;
  reviewedHeadSha?: string;
  change: ChangeRequestEventContext;
}): string {
  return (
    options.reviewedHeadSha ??
    options.plan?.metadata.reviewedHeadSha ??
    options.change.change.head.sha
  );
}

type ThreadActionContext = {
  client: GitHubPublicationClient;
  change: ChangeRequestEventContext;
  reviewedHeadSha: string;
  resolvedKeys: Set<string>;
  responseMarkers: Set<string>;
  threadById: Map<string, GitHubReviewThread>;
  threadByCommentId: Map<number, GitHubReviewThread>;
};

async function publishThreadAction(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): Promise<string[]> {
  const errors: string[] = [];
  if (action.kind === "resolve" && threadActionAlreadyResolved(context, action)) {
    return errors;
  }
  const replyError = await postThreadActionReplyIfNeeded(context, action);
  if (replyError) {
    errors.push(replyError);
  }
  if (action.kind === "resolve") {
    const resolveError = await resolveReviewThread(context, action);
    if (resolveError) {
      errors.push(resolveError);
    }
  }
  return errors;
}

function threadActionAlreadyResolved(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): boolean {
  return action.kind === "resolve" && Boolean(threadForAction(context, action)?.isResolved);
}

async function postThreadActionReplyIfNeeded(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): Promise<string | undefined> {
  const reply = threadActionReply(action);
  const markerKey = threadActionReplyKey(action);
  if (threadActionReplyExists(context, action, markerKey)) {
    return undefined;
  }
  try {
    await context.client.createReviewCommentReply({
      repo: context.change.repository.slug,
      pullRequestNumber: context.change.change.number,
      commentId: Number(action.commentId),
      body: reply.body,
    });
    recordThreadActionReply(context, action, markerKey);
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `reply to verifier action '${action.findingId}': ${message}`;
  }
}

async function loadThreadActionThreads(
  context: ThreadActionContext,
  actions: PublicationPlan["threadActions"],
): Promise<{
  threads: Map<string, GitHubReviewThread>;
  threadsByCommentId: Map<number, GitHubReviewThread>;
  error?: string;
}> {
  if (!actions.some((action) => action.kind === "resolve")) {
    return { threads: new Map(), threadsByCommentId: new Map() };
  }
  try {
    const threads = await context.client.listReviewThreads({
      repo: context.change.repository.slug,
      pullRequestNumber: context.change.change.number,
    });
    return {
      threads: new Map(threads.map((thread) => [thread.id, thread])),
      threadsByCommentId: reviewThreadByCommentId(threads),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      threads: new Map(),
      threadsByCommentId: new Map(),
      error: `list review threads for verifier actions: ${message}`,
    };
  }
}

function threadActionReplyKey(action: PublicationPlan["threadActions"][number]): string {
  return action.kind === "resolve"
    ? `${action.findingId}:${action.findingHeadSha}`
    : `pipr:verifier-response:${action.findingId}:${action.responseKey}`;
}

function threadActionReplyExists(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
  markerKey: string,
): boolean {
  return action.kind === "resolve"
    ? context.resolvedKeys.has(markerKey)
    : context.responseMarkers.has(markerKey);
}

function recordThreadActionReply(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
  markerKey: string,
): void {
  if (action.kind === "resolve") {
    context.resolvedKeys.add(markerKey);
    return;
  }
  context.responseMarkers.add(markerKey);
}

async function resolveReviewThread(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): Promise<string | undefined> {
  const thread = threadForAction(context, action);
  const threadId = action.threadId ?? thread?.id;
  if (!threadId) {
    return `GitHub review thread not found for pipr finding '${action.findingId}'`;
  }
  try {
    if (thread?.isResolved) {
      return undefined;
    }
    await context.client.resolveReviewThread({ threadId });
    return undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `resolve thread '${threadId}' for finding '${action.findingId}': ${message}`;
  }
}

function threadForAction(
  context: ThreadActionContext,
  action: PublicationPlan["threadActions"][number],
): GitHubReviewThread | undefined {
  if (action.kind !== "resolve") {
    return undefined;
  }
  return (
    (action.threadId ? context.threadById.get(action.threadId) : undefined) ??
    context.threadByCommentId.get(Number(action.commentId))
  );
}
