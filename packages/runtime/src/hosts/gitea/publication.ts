import { firstNonEmptyLine } from "../../commands/grammar.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  mainCommentMarker,
  parseMainCommentIdentity,
} from "../../review/prior-state.js";
import { PublicationError } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { nativeInlineLocation } from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type { GiteaClient, GiteaComment, GiteaReviewComment } from "./client.js";

export async function assertCurrentGiteaHead(
  client: GiteaClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha: string,
): Promise<void> {
  const coordinates = giteaCoordinates(change);
  const pullRequest = await client.getPullRequest(
    coordinates.owner,
    coordinates.repository,
    change.change.number,
  );
  if (pullRequest.head.sha !== reviewedHeadSha) {
    throw new PublicationError(
      `Change request head changed from '${reviewedHeadSha}' to '${pullRequest.head.sha}' before publication`,
      undefined,
    );
  }
}

export async function loadGiteaPriorMainComment(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
}): Promise<string | undefined> {
  const coordinates = giteaCoordinates(options.change);
  const owner = await options.client.currentUser();
  const comments = await options.client.listIssueComments(
    coordinates.owner,
    coordinates.repository,
    options.change.change.number,
  );
  return findGiteaMainComment(
    comments,
    owner.login,
    mainCommentMarker,
    options.change.change.number,
  )?.body;
}

export async function loadGiteaPriorReviewState(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
}) {
  const mainComment = await loadGiteaPriorMainComment(options);
  const state = extractPriorReviewState(mainComment, options.change.change.number);
  if (!state) return undefined;
  const owner = await options.client.currentUser();
  const inlineBodies = (await loadGiteaReviewComments(options.client, options.change))
    .filter((comment) => comment.authorLogin === owner.login)
    .map((comment) => comment.body);
  return applyResolvedFindingMarkers(applyInlineFindingMarkers(state, inlineBodies), inlineBodies);
}

export async function loadGiteaInlineThreadContexts(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const owner = await options.client.currentUser();
  const comments = await loadGiteaReviewComments(options.client, options.change);
  return giteaThreadContexts(comments, owner.login, false);
}

export function giteaThreadContexts(
  comments: GiteaReviewComment[],
  ownerLogin: string,
  ownedRepliesOnly: boolean,
): InlineThreadContext[] {
  const byRoot = new Map<string, GiteaReviewComment[]>();
  for (const comment of comments) {
    const rootId = comment.parentId ?? comment.id;
    const values = byRoot.get(rootId) ?? [];
    values.push(comment);
    byRoot.set(rootId, values);
  }
  return [...byRoot.entries()].flatMap(([rootId, thread]) => {
    const root = thread.find((comment) => comment.id === rootId);
    const marker = root ? extractInlineFindingMarkerRecords([root.body])[0] : undefined;
    if (!root || !marker || root.authorLogin !== ownerLogin) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.body,
        threadResolved: false,
        comments: thread.flatMap((comment) =>
          !ownedRepliesOnly || comment.authorLogin === ownerLogin
            ? [{ id: comment.id, body: comment.body, authorLogin: comment.authorLogin }]
            : [],
        ),
      },
    ];
  });
}

export function findGiteaMainComment(
  comments: GiteaComment[],
  ownerLogin: string,
  marker: string,
  changeNumber: number,
): GiteaComment | undefined {
  return comments.find((comment) => {
    if (comment.authorLogin !== ownerLogin) return false;
    const identity = parseMainCommentIdentity(firstNonEmptyLine(comment.body));
    return identity?.marker === marker && identity.changeNumber === changeNumber;
  });
}

function loadGiteaReviewComments(
  client: GiteaClient,
  change: ChangeRequestEventContext,
): Promise<GiteaReviewComment[]> {
  const coordinates = giteaCoordinates(change);
  return client.listReviewComments(coordinates.owner, coordinates.repository, change.change.number);
}

export function giteaCoordinates(change: ChangeRequestEventContext) {
  if (change.coordinates?.provider !== "gitea") {
    throw new Error("Gitea-compatible adapter requires Gitea coordinates");
  }
  return change.coordinates;
}

export function giteaReviewCommentLocation(comment: GiteaReviewComment) {
  if (!comment.path || !comment.commitId || !comment.side || comment.line === undefined) {
    return undefined;
  }
  return nativeInlineLocation({
    commitId: comment.commitId,
    rightPath: comment.path,
    leftPath: comment.path,
    ...(comment.side === "RIGHT"
      ? { rightStart: comment.line, rightEnd: comment.line }
      : { leftStart: comment.line, leftEnd: comment.line }),
  });
}

export function giteaDisplayName(host: GiteaClient["host"]): string {
  return host === "gitea" ? "Gitea" : host === "forgejo" ? "Forgejo" : "Codeberg";
}
