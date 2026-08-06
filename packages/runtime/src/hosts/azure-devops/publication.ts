import path from "node:path";
import type { InlinePublicationItem, PublicationPlan, ThreadAction } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import {
  applyInlineFindingMarkers,
  applyNativeThreadResolutions,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  type PriorReviewState,
} from "../../review/prior-state.js";
import {
  extractReviewProgressToken,
  type ReviewProgressLease,
  ReviewProgressSupersededError,
} from "../../review/progress.js";
import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  assertHostInlinePublicationSucceeded,
  assertHostPublicationWriteAllowed,
  commandResponseBody,
  completeHostPublication,
  hostPublicationActionError,
  nativeInlineLocation,
  publishUnseenInlineItems,
  threadActionReply,
} from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type { AzureDevOpsClient, AzureDevOpsIterationChange, AzureDevOpsThread } from "./client.js";

export function azureInlineLocationFromThread(
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

export function azureInlineLocation(item: InlinePublicationItem): InlinePublicationLocation {
  return {
    path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

export async function loadAzureDevOpsPriorReviewState(options: {
  client: AzureDevOpsClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const body = await loadAzureDevOpsPriorMainComment(options);
  const state = extractPriorReviewState(body, options.change.change.number);
  if (!state) return undefined;
  const owner = await authenticatedAzureOwner(options.client);
  const threads = await options.client.listThreads(
    azureCoordinates(options.change).repositoryId,
    options.change.change.number,
  );
  const bodies = ownedThreadComments(threads, owner.uniqueName).map((comment) => comment.content);
  const markerState = applyResolvedFindingMarkers(applyInlineFindingMarkers(state, bodies), bodies);
  return applyNativeThreadResolutions(
    markerState,
    threads.flatMap((thread) => {
      const root = thread.comments[0];
      const marker = root ? extractInlineFindingMarkerRecords([root.content])[0] : undefined;
      return root && marker && root.author?.uniqueName === owner.uniqueName
        ? [
            {
              findingId: marker.id,
              findingHeadSha: marker.head,
              resolved: isAzureThreadResolved(thread),
            },
          ]
        : [];
    }),
  );
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
  return ownedAzureRootThread(
    threads,
    owner.uniqueName,
    azureMainMarker(options.change.change.number),
  )?.comments[0]?.content;
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
        threadResolved: isAzureThreadResolved(thread),
        comments: thread.comments.map((comment) => ({
          id: comment.id,
          body: comment.content,
          authorLogin: comment.author?.uniqueName,
        })),
      },
    ];
  });
}

export async function azureInlineThread(
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
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", "show", `${sha}:${filePath}`], { cwd: root });
  } catch (error) {
    throw new Error(`Azure DevOps could not read ${side} blob ${sha}:${filePath}`, {
      cause: error,
    });
  }
  if (result.exitCode !== 0) {
    throw new Error(`Azure DevOps could not read ${side} blob ${sha}:${filePath}`);
  }
  if (!result.stdout) {
    throw new Error(`Azure DevOps returned no ${side} blob data for ${sha}:${filePath}`);
  }
  const content = result.stdout.toString().split(/\r?\n/)[line - 1];
  if (content === undefined) {
    throw new Error(`Azure DevOps line ${line} is outside ${side} blob ${sha}:${filePath}`);
  }
  return content.length + 1;
}

export async function currentAzureNativeChange(
  client: AzureDevOpsClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const pullRequest = await assertCurrentAzurePullRequest(client, change, reviewedHeadSha);
  const coordinates = azureCoordinates(change);
  const iterations = await client.listIterations(coordinates.repositoryId, change.change.number);
  const iteration = iterations.findLast((candidate) => candidate.headSha === reviewedHeadSha);
  if (!iteration)
    throw new Error(`Azure DevOps has no pull request iteration for head ${reviewedHeadSha}`);
  return { pullRequest, iterationId: iteration.id };
}

export async function assertCurrentAzurePullRequest(
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

export function azureCoordinates(change: ChangeRequestEventContext) {
  if (change.coordinates?.provider !== "azure-devops") {
    throw new Error("Azure DevOps adapter requires Azure DevOps coordinates");
  }
  return change.coordinates;
}

export function ownedAzureRootThread(
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

export async function authenticatedAzureOwner(
  client: AzureDevOpsClient,
): Promise<{ uniqueName: string }> {
  const owner = await client.currentUser();
  if (!owner.uniqueName) {
    throw new Error("Azure DevOps authenticated user unique name is required");
  }
  return { uniqueName: owner.uniqueName };
}

export function unpositionedAzureThread(content: string) {
  return { comments: [{ parentCommentId: 0, content, commentType: 1 }], status: "active" };
}

export function isAzureThreadResolved(thread: AzureDevOpsThread): boolean {
  return (
    thread.status === "fixed" ||
    thread.status === "closed" ||
    thread.status === "wontFix" ||
    thread.status === "byDesign"
  );
}

export function azureMainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}
