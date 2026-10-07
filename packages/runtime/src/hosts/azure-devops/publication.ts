import path from "node:path";
import type { InlinePublicationItem, InlineThreadContext } from "../../publication/types.js";
import { parseInlineFindingMarker } from "../../review/comment-markers.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { requireCoordinates } from "../change-request.js";
import { inlineItemPath, nativeInlineLocation } from "../publication.js";
import type { AzureDevOpsClient, AzureDevOpsIterationChange, AzureDevOpsThread } from "./client.js";

export function azureInlineLocationFromThread(
  thread: AzureDevOpsThread,
): InlinePublicationLocation | undefined {
  const root = thread.comments[0];
  const context = thread.threadContext;
  if (!root || !context?.filePath) return undefined;
  const marker = parseInlineFindingMarker(root.content);
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

export function azureThreadContexts(
  threads: AzureDevOpsThread[],
  ownerUniqueName: string,
  ownedRepliesOnly: boolean,
): InlineThreadContext[] {
  return threads.flatMap((thread) => {
    const root = thread.comments[0];
    const marker = root ? parseInlineFindingMarker(root.content) : undefined;
    if (!root || !marker || root.author?.uniqueName !== ownerUniqueName) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.content,
        threadId: thread.id,
        threadResolved: isAzureThreadResolved(thread),
        comments: thread.comments.flatMap((comment) =>
          !ownedRepliesOnly || comment.author?.uniqueName === ownerUniqueName
            ? [{ id: comment.id, body: comment.content, authorLogin: comment.author?.uniqueName }]
            : [],
        ),
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
  const selectedPath = inlineItemPath(item);
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

/**
 * Asserts the pull request still matches the change and returns the head iteration.
 * `endpointsChangedMessage` replaces the specific head/base drift messages.
 */
export async function currentAzureNativeChange(
  client: AzureDevOpsClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
  endpointsChangedMessage?: string,
) {
  const pullRequest = await assertCurrentAzurePullRequest(
    client,
    change,
    reviewedHeadSha,
    endpointsChangedMessage,
  );
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
  endpointsChangedMessage?: string,
) {
  const coordinates = azureCoordinates(change);
  const pullRequest = await client.getPullRequest(coordinates.repositoryId, change.change.number);
  if (pullRequest.lastMergeSourceCommit.commitId !== reviewedHeadSha) {
    throw new Error(
      endpointsChangedMessage ??
        `Azure DevOps pull request head changed from ${reviewedHeadSha} to ${pullRequest.lastMergeSourceCommit.commitId}`,
    );
  }
  if (pullRequest.lastMergeTargetCommit.commitId !== change.change.base.sha) {
    throw new Error(
      endpointsChangedMessage ??
        `Azure DevOps pull request base changed from ${change.change.base.sha} to ${pullRequest.lastMergeTargetCommit.commitId}`,
    );
  }
  return pullRequest;
}

export function azureCoordinates(change: Pick<ChangeRequestEventContext, "coordinates">) {
  return requireCoordinates(change, "azure-devops", "Azure DevOps");
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
