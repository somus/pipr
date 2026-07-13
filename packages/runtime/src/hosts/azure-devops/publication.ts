import path from "node:path";
import type { InlinePublicationItem, PublicationPlan, ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  type PriorReviewState,
} from "../../review/prior-state.js";
import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  commandResponseBody,
  completeHostPublication,
  nativeInlineLocation,
  publishUnseenInlineItems,
  threadActionReply,
} from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type { AzureDevOpsClient, AzureDevOpsIterationChange, AzureDevOpsThread } from "./client.js";

export async function publishAzureDevOpsPlan(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  const coordinates = azureCoordinates(options.change);
  const native = await currentNativeChange(options.client, options.change);
  const { owner, threads } = await loadAzureWriteState(
    options.client,
    options.change,
    options.plan.metadata.reviewedHeadSha,
  );
  const existingMain = ownedRootThread(
    threads,
    owner.uniqueName,
    mainMarker(options.change.change.number),
  );
  const main = existingMain
    ? await options.client.updateComment(
        coordinates.repositoryId,
        options.change.change.number,
        existingMain.id,
        existingMain.comments[0]?.id ?? "",
        options.plan.mainComment,
      )
    : (
        await options.client.createThread(
          coordinates.repositoryId,
          options.change.change.number,
          unpositionedThread(options.plan.mainComment),
        )
      ).comments[0];
  if (!main) throw new Error("Azure DevOps did not return the Main Review Comment");
  const markerBodies = ownedThreadComments(threads, owner.uniqueName).map(
    (comment) => comment.content,
  );
  const changes = await options.client.listIterationChanges(
    coordinates.repositoryId,
    options.change.change.number,
    native.iterationId,
  );
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: markerBodies,
    existingLocations: azureInlineLocations(threads, owner.uniqueName),
    location: azureInlineLocation,
    publish: async (item) => {
      await options.client.createThread(
        coordinates.repositoryId,
        options.change.change.number,
        await inlineThread(options.change, item, changes, native.iterationId),
      );
    },
  });
  const resolution = await publishAzureDevOpsThreadActions({
    client: options.client,
    change: options.change,
    actions: options.plan.threadActions,
    reviewedHeadSha: options.plan.metadata.reviewedHeadSha,
    threads,
    ownerUniqueName: owner.uniqueName,
  });
  return completeHostPublication({
    provider: "Azure DevOps",
    mainAction: existingMain ? "updated" : "created",
    mainId: main.id,
    inline,
    resolutionErrors: resolution.errors,
    metadata: options.plan.metadata,
  });
}

function azureInlineLocations(
  threads: AzureDevOpsThread[],
  ownerUniqueName: string,
): InlinePublicationLocation[] {
  const locations: InlinePublicationLocation[] = [];
  for (const thread of threads) {
    if (!ownerUniqueName || thread.comments[0]?.author?.uniqueName !== ownerUniqueName) continue;
    const location = azureInlineLocationFromThread(thread);
    if (location) locations.push(location);
  }
  return locations;
}

function azureInlineLocationFromThread(
  thread: AzureDevOpsThread,
): InlinePublicationLocation | undefined {
  const root = thread.comments[0];
  const context = thread.threadContext;
  if (!root || !context?.filePath) return undefined;
  const marker = extractInlineFindingMarkerRecords([root.content])[0];
  if (!marker) return undefined;
  const path = context.filePath.replace(/^\/+/, "");
  return nativeInlineLocation({
    commitId: marker.head,
    rightPath: path,
    leftPath: path,
    rightStart: context.rightFileStart?.line,
    rightEnd: context.rightFileEnd?.line,
    leftStart: context.leftFileStart?.line,
    leftEnd: context.leftFileEnd?.line,
  });
}

function azureInlineLocation(item: InlinePublicationItem): InlinePublicationLocation {
  return {
    path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

export async function publishAzureDevOpsCommandResponse(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  body: string;
}) {
  const coordinates = azureCoordinates(options.change);
  const response = commandResponseBody({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
    body: options.body,
  });
  await currentPullRequest(options.client, options.change);
  const { owner, threads } = await loadAzureWriteState(options.client, options.change);
  const existing = ownedRootThread(threads, owner.uniqueName, response.marker);
  const comment = existing
    ? await options.client.updateComment(
        coordinates.repositoryId,
        options.change.change.number,
        existing.id,
        existing.comments[0]?.id ?? "",
        response.body,
      )
    : (
        await options.client.createThread(
          coordinates.repositoryId,
          options.change.change.number,
          unpositionedThread(response.body),
        )
      ).comments[0];
  if (!comment) throw new Error("Azure DevOps did not return the command response comment");
  return { action: existing ? ("updated" as const) : ("created" as const), id: comment.id };
}

async function loadAzureWriteState(
  client: AzureDevOpsClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const owner = await authenticatedAzureOwner(client);
  const threads = await client.listThreads(
    azureCoordinates(change).repositoryId,
    change.change.number,
  );
  await currentPullRequest(client, change, reviewedHeadSha);
  return { owner, threads };
}

export async function loadAzureDevOpsPriorReviewState(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const body = await loadAzureDevOpsPriorMainComment(options);
  const state = extractPriorReviewState(body, options.change.change.number);
  if (!state) return undefined;
  const owner = await authenticatedAzureOwner(options.client);
  const bodies = ownedThreadComments(
    await options.client.listThreads(
      azureCoordinates(options.change).repositoryId,
      options.change.change.number,
    ),
    owner.uniqueName,
  ).map((comment) => comment.content);
  return applyResolvedFindingMarkers(applyInlineFindingMarkers(state, bodies), bodies);
}

export async function loadAzureDevOpsPriorMainComment(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
}): Promise<string | undefined> {
  const owner = await authenticatedAzureOwner(options.client);
  const threads = await options.client.listThreads(
    azureCoordinates(options.change).repositoryId,
    options.change.change.number,
  );
  return ownedRootThread(threads, owner.uniqueName, mainMarker(options.change.change.number))
    ?.comments[0]?.content;
}

export async function loadAzureDevOpsInlineThreadContexts(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const owner = await authenticatedAzureOwner(options.client);
  const threads = await options.client.listThreads(
    azureCoordinates(options.change).repositoryId,
    options.change.change.number,
  );
  return threads.flatMap((thread) => {
    const root = thread.comments[0];
    const marker = root ? extractInlineFindingMarkerRecords([root.content])[0] : undefined;
    if (!root || !marker || root.author?.uniqueName !== owner.uniqueName) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.content,
        threadId: thread.id,
        threadResolved: isResolved(thread),
        comments: thread.comments.map((comment) => ({
          id: comment.id,
          body: comment.content,
          authorLogin: comment.author?.uniqueName,
        })),
      },
    ];
  });
}

export async function publishAzureDevOpsThreadActions(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
  actions: ThreadAction[];
  reviewedHeadSha: string;
  threads?: AzureDevOpsThread[];
  ownerUniqueName?: string;
}): Promise<{ errors: string[] }> {
  if (options.actions.length === 0) return { errors: [] };
  const coordinates = azureCoordinates(options.change);
  await currentNativeChange(options.client, options.change, options.reviewedHeadSha);
  const threads =
    options.threads ??
    (await options.client.listThreads(coordinates.repositoryId, options.change.change.number));
  const ownerUniqueName =
    options.ownerUniqueName ?? (await authenticatedAzureOwner(options.client)).uniqueName;
  if (!ownerUniqueName) throw new Error("Azure DevOps authenticated user unique name is required");
  await currentNativeChange(options.client, options.change, options.reviewedHeadSha);
  const byComment = new Map(
    threads.flatMap((thread) => thread.comments.map((comment) => [comment.id, thread])),
  );
  const errors: string[] = [];
  for (const action of options.actions) {
    const thread = action.threadId
      ? threads.find((candidate) => candidate.id === action.threadId)
      : byComment.get(action.commentId);
    const error = await publishAzureDevOpsThreadAction({
      client: options.client,
      repositoryId: coordinates.repositoryId,
      changeNumber: options.change.change.number,
      action,
      thread,
      ownerUniqueName,
    });
    if (error) errors.push(error);
  }
  return { errors };
}

async function publishAzureDevOpsThreadAction(options: {
  client: AzureDevOpsClient;
  repositoryId: string;
  changeNumber: number;
  action: ThreadAction;
  thread?: AzureDevOpsThread;
  ownerUniqueName: string;
}): Promise<string | undefined> {
  if (!options.thread)
    return `Azure DevOps thread not found for comment ${options.action.commentId}`;
  try {
    const reply = threadActionReply(options.action);
    if (
      !options.thread.comments.some(
        (comment) =>
          comment.author?.uniqueName === options.ownerUniqueName &&
          comment.content.includes(reply.marker),
      )
    ) {
      await options.client.createThreadComment(
        options.repositoryId,
        options.changeNumber,
        options.thread.id,
        {
          parentCommentId: Number(options.thread.comments[0]?.id ?? 0),
          content: reply.body,
          commentType: 1,
        },
      );
    }
    if (options.action.kind === "resolve" && !isResolved(options.thread)) {
      await options.client.updateThreadStatus(
        options.repositoryId,
        options.changeNumber,
        options.thread.id,
        "fixed",
      );
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

async function inlineThread(
  change: ChangeRequestEventContext,
  item: InlinePublicationItem,
  changes: AzureDevOpsIterationChange[],
  iterationId: number,
): Promise<Record<string, unknown>> {
  const selectedPath = item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path;
  const nativeChange = changes.find((candidate) => {
    const candidatePath =
      candidate.path === selectedPath || candidate.originalPath === selectedPath;
    if (!candidatePath) return false;
    const changeType = candidate.changeType.toLowerCase();
    return item.side === "LEFT" ? changeType !== "add" : changeType !== "delete";
  });
  if (!nativeChange) throw new Error(`Azure DevOps changeTrackingId not found for ${selectedPath}`);
  const start = { line: item.startLine, offset: 1 };
  const end = {
    line: item.endLine,
    offset: await lineEndOffset(change, selectedPath, item.endLine, item.side),
  };
  return {
    comments: [{ parentCommentId: 0, content: item.body, commentType: 1 }],
    status: "active",
    threadContext: {
      filePath: `/${selectedPath.replace(/^\/+/, "")}`,
      ...(item.side === "RIGHT"
        ? { rightFileStart: start, rightFileEnd: end }
        : { leftFileStart: start, leftFileEnd: end }),
    },
    pullRequestThreadContext: {
      changeTrackingId: nativeChange.changeTrackingId,
      iterationContext: { firstComparingIteration: 1, secondComparingIteration: iterationId },
    },
  };
}

async function lineEndOffset(
  change: ChangeRequestEventContext,
  filePath: string,
  line: number,
  side: "LEFT" | "RIGHT",
): Promise<number> {
  const root = path.resolve(change.workspace);
  const sha = side === "RIGHT" ? change.change.head.sha : change.change.base.sha;
  try {
    const result = Bun.spawnSync(["git", "show", `${sha}:${filePath}`], { cwd: root });
    if (result.exitCode !== 0) return 1;
    const content = result.stdout.toString().split(/\r?\n/)[line - 1];
    return content === undefined ? 1 : content.length + 1;
  } catch {
    return 1;
  }
}

async function currentNativeChange(
  client: AzureDevOpsClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const pullRequest = await currentPullRequest(client, change, reviewedHeadSha);
  const coordinates = azureCoordinates(change);
  const iterations = await client.listIterations(coordinates.repositoryId, change.change.number);
  const iteration = iterations.findLast((candidate) => candidate.headSha === reviewedHeadSha);
  if (!iteration)
    throw new Error(`Azure DevOps has no pull request iteration for head ${reviewedHeadSha}`);
  return { pullRequest, iterationId: iteration.id };
}

async function currentPullRequest(
  client: AzureDevOpsClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const coordinates = azureCoordinates(change);
  const pullRequest = await client.getPullRequest(coordinates.repositoryId, change.change.number);
  if (pullRequest.lastMergeSourceCommit.commitId !== reviewedHeadSha) {
    throw new Error(
      `Azure DevOps pull request head changed from ${reviewedHeadSha} to ${pullRequest.lastMergeSourceCommit.commitId}`,
    );
  }
  if (pullRequest.lastMergeTargetCommit.commitId !== change.change.base.sha) {
    throw new Error(
      `Azure DevOps pull request base changed from ${change.change.base.sha} to ${pullRequest.lastMergeTargetCommit.commitId}`,
    );
  }
  return pullRequest;
}

function azureCoordinates(change: ChangeRequestEventContext) {
  if (change.coordinates?.provider !== "azure-devops") {
    throw new Error("Azure DevOps adapter requires Azure DevOps coordinates");
  }
  return change.coordinates;
}

function ownedRootThread(
  threads: AzureDevOpsThread[],
  uniqueName: string,
  marker: string,
): AzureDevOpsThread | undefined {
  return threads.find((thread) => {
    const root = thread.comments[0];
    return (
      !thread.threadContext?.filePath &&
      root?.author?.uniqueName === uniqueName &&
      root.content.trimStart().startsWith(marker)
    );
  });
}

function ownedThreadComments(threads: AzureDevOpsThread[], uniqueName: string) {
  return threads.flatMap((thread) =>
    thread.comments.filter((comment) => comment.author?.uniqueName === uniqueName),
  );
}

async function authenticatedAzureOwner(client: AzureDevOpsClient): Promise<{ uniqueName: string }> {
  const owner = await client.currentUser();
  if (!owner.uniqueName) {
    throw new Error("Azure DevOps authenticated user unique name is required");
  }
  return { uniqueName: owner.uniqueName };
}

function unpositionedThread(content: string) {
  return { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: "active" };
}

function isResolved(thread: AzureDevOpsThread): boolean {
  return (
    thread.status === "fixed" ||
    thread.status === "closed" ||
    thread.status === "wontFix" ||
    thread.status === "byDesign"
  );
}

function mainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}
