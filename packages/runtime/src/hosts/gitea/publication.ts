import { firstNonEmptyLine } from "../../commands/grammar.js";
import type { PublicationPlan, ThreadAction } from "../../review/comment.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  mainCommentMarker,
  parseMainCommentIdentity,
} from "../../review/prior-state.js";
import {
  extractReviewProgressToken,
  type ReviewProgressLease,
  ReviewProgressSupersededError,
} from "../../review/progress.js";
import { PublicationError, type PublicationResult } from "../../review/publication-result.js";
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
import type { GiteaClient, GiteaComment, GiteaReviewComment } from "./client.js";

export async function publishGiteaPlan(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
  progressLease?: ReviewProgressLease;
}): Promise<PublicationResult> {
  const coordinates = giteaCoordinates(options.change);
  await assertCurrentGiteaHead(
    options.client,
    options.change,
    options.plan.metadata.reviewedHeadSha,
  );
  const owner = await options.client.currentUser();
  const comments = await options.client.listIssueComments(
    coordinates.owner,
    coordinates.repository,
    options.change.change.number,
  );
  const existing = findMainComment(
    comments,
    owner.login,
    options.plan.mainMarker,
    options.change.change.number,
  );
  assertProgressLease(existing, options.progressLease);
  const reviewComments = (
    await options.client.listReviewComments(
      coordinates.owner,
      coordinates.repository,
      options.change.change.number,
    )
  ).filter((comment) => comment.authorLogin === owner.login);
  const existingLocations = reviewComments.flatMap((comment) => {
    const location = giteaReviewCommentLocation(comment);
    return location ? [location] : [];
  });
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: reviewComments.map((comment) => comment.body),
    existingLocations,
    location: (item) => ({
      path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
      commitId: item.reviewedHeadSha,
      side: item.side,
      startLine: item.endLine,
      endLine: item.endLine,
    }),
    beforePublish: () => assertCurrentProgressLease(options, owner.login),
    publish: (item) =>
      options.client.createReviewComment(
        coordinates.owner,
        coordinates.repository,
        options.change.change.number,
        {
          body: item.body,
          path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
          commitId: item.reviewedHeadSha,
          line: item.endLine,
          side: item.side,
        },
      ),
  });
  if (options.progressLease) {
    assertHostInlinePublicationSucceeded({
      provider: displayName(options.client.host),
      inline,
      resolutionErrors: [],
      metadata: options.plan.metadata,
    });
  }
  await assertCurrentGiteaHead(
    options.client,
    options.change,
    options.plan.metadata.reviewedHeadSha,
  );
  const currentComments = await options.client.listIssueComments(
    coordinates.owner,
    coordinates.repository,
    options.change.change.number,
  );
  const currentExisting = findMainComment(
    currentComments,
    owner.login,
    options.plan.mainMarker,
    options.change.change.number,
  );
  assertProgressLease(currentExisting, options.progressLease);
  const main = currentExisting
    ? await options.client.updateIssueComment(
        coordinates.owner,
        coordinates.repository,
        currentExisting.id,
        options.plan.mainComment,
      )
    : await options.client.createIssueComment(
        coordinates.owner,
        coordinates.repository,
        options.change.change.number,
        options.plan.mainComment,
      );
  return completeHostPublication({
    provider: displayName(options.client.host),
    mainAction:
      options.progressLease?.mainCommentAction ?? (currentExisting ? "updated" : "created"),
    mainId: main.id,
    inline,
    resolutionErrors: [],
    metadata: options.plan.metadata,
  });
}

export async function publishGiteaReviewProgress(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
  renderBody(currentBody: string | undefined): string;
  reviewedHeadSha: string;
  expectedToken?: string;
}) {
  const coordinates = giteaCoordinates(options.change);
  const owner = await options.client.currentUser();
  await assertCurrentGiteaHead(options.client, options.change, options.reviewedHeadSha);
  let existing = await loadOwnedMainComment(
    options.client,
    options.change,
    owner.login,
    mainCommentMarker,
  );
  if (
    options.expectedToken &&
    extractReviewProgressToken(existing?.body) !== options.expectedToken
  ) {
    return { status: "superseded" as const };
  }
  await assertCurrentGiteaHead(options.client, options.change, options.reviewedHeadSha);
  existing = await loadOwnedMainComment(
    options.client,
    options.change,
    owner.login,
    mainCommentMarker,
  );
  if (
    options.expectedToken &&
    extractReviewProgressToken(existing?.body) !== options.expectedToken
  ) {
    return { status: "superseded" as const };
  }
  if (existing) {
    const updated = await options.client.updateIssueComment(
      coordinates.owner,
      coordinates.repository,
      existing.id,
      options.renderBody(existing.body),
    );
    return {
      status: "published" as const,
      action: "updated" as const,
      id: updated.id,
    };
  }
  if (options.expectedToken) return { status: "superseded" as const };
  const created = await options.client.createIssueComment(
    coordinates.owner,
    coordinates.repository,
    options.change.change.number,
    options.renderBody(undefined),
  );
  return { status: "published" as const, action: "created" as const, id: created.id };
}

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

export async function publishGiteaCommandResponse(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  body: string;
  allowHeadDrift?: boolean;
}) {
  const coordinates = giteaCoordinates(options.change);
  if (!options.allowHeadDrift) {
    await assertCurrentGiteaHead(options.client, options.change, options.change.change.head.sha);
  }
  const owner = await options.client.currentUser();
  const response = commandResponseBody({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
    body: options.body,
  });
  const comments = await options.client.listIssueComments(
    coordinates.owner,
    coordinates.repository,
    options.change.change.number,
  );
  if (!options.allowHeadDrift) {
    await assertCurrentGiteaHead(options.client, options.change, options.change.change.head.sha);
  }
  const existing = comments.find(
    (comment) =>
      comment.authorLogin === owner.login && firstNonEmptyLine(comment.body) === response.marker,
  );
  const comment = existing
    ? await options.client.updateIssueComment(
        coordinates.owner,
        coordinates.repository,
        existing.id,
        response.body,
      )
    : await options.client.createIssueComment(
        coordinates.owner,
        coordinates.repository,
        options.change.change.number,
        response.body,
      );
  return { action: existing ? ("updated" as const) : ("created" as const), id: comment.id };
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
  return findMainComment(comments, owner.login, mainCommentMarker, options.change.change.number)
    ?.body;
}

export async function loadGiteaPriorReviewState(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
}) {
  const mainComment = await loadGiteaPriorMainComment(options);
  const state = extractPriorReviewState(mainComment, options.change.change.number);
  if (!state) return undefined;
  const owner = await options.client.currentUser();
  const inlineBodies = (await loadReviewComments(options.client, options.change))
    .filter((comment) => comment.authorLogin === owner.login)
    .map((comment) => comment.body);
  return applyResolvedFindingMarkers(applyInlineFindingMarkers(state, inlineBodies), inlineBodies);
}

export async function loadGiteaInlineThreadContexts(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const owner = await options.client.currentUser();
  const comments = await loadReviewComments(options.client, options.change);
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
    if (!root || !marker || root.authorLogin !== owner.login) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.body,
        threadResolved: false,
        comments: thread.map((comment) => ({
          id: comment.id,
          body: comment.body,
          authorLogin: comment.authorLogin,
        })),
      },
    ];
  });
}

export async function publishGiteaThreadActions(options: {
  client: GiteaClient;
  change: ChangeRequestEventContext;
  actions: ThreadAction[];
  reviewedHeadSha: string;
}): Promise<{ errors: string[] }> {
  if (options.actions.length === 0) return { errors: [] };
  await assertCurrentGiteaHead(options.client, options.change, options.reviewedHeadSha);
  const coordinates = giteaCoordinates(options.change);
  const owner = await options.client.currentUser();
  const comments = await loadReviewComments(options.client, options.change);
  await assertCurrentGiteaHead(options.client, options.change, options.reviewedHeadSha);
  const errors: string[] = [];
  for (const action of options.actions) {
    if (action.kind === "resolve") {
      errors.push(`${displayName(options.client.host)} does not support resolving review threads`);
      continue;
    }
    const reply = threadActionReply(action);
    const owned = comments.some(
      (comment) =>
        comment.parentId === action.commentId &&
        comment.authorLogin === owner.login &&
        comment.body.includes(reply.marker),
    );
    if (owned) continue;
    try {
      await assertHostPublicationWriteAllowed(() =>
        assertCurrentGiteaHead(options.client, options.change, options.reviewedHeadSha),
      );
      await options.client.replyToReviewComment(
        coordinates.owner,
        coordinates.repository,
        options.change.change.number,
        action.commentId,
        reply.body,
      );
    } catch (error) {
      errors.push(hostPublicationActionError(error));
    }
  }
  return { errors };
}

function findMainComment(
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

async function loadOwnedMainComment(
  client: GiteaClient,
  change: ChangeRequestEventContext,
  ownerLogin: string,
  marker: string,
): Promise<GiteaComment | undefined> {
  const coordinates = giteaCoordinates(change);
  const comments = await client.listIssueComments(
    coordinates.owner,
    coordinates.repository,
    change.change.number,
  );
  return findMainComment(comments, ownerLogin, marker, change.change.number);
}

function loadReviewComments(
  client: GiteaClient,
  change: ChangeRequestEventContext,
): Promise<GiteaReviewComment[]> {
  const coordinates = giteaCoordinates(change);
  return client.listReviewComments(coordinates.owner, coordinates.repository, change.change.number);
}

async function assertCurrentProgressLease(
  options: {
    client: GiteaClient;
    change: ChangeRequestEventContext;
    plan: PublicationPlan;
    progressLease?: ReviewProgressLease;
  },
  ownerLogin: string,
): Promise<void> {
  await assertCurrentGiteaHead(
    options.client,
    options.change,
    options.plan.metadata.reviewedHeadSha,
  );
  if (!options.progressLease) return;
  const coordinates = giteaCoordinates(options.change);
  const main = findMainComment(
    await options.client.listIssueComments(
      coordinates.owner,
      coordinates.repository,
      options.change.change.number,
    ),
    ownerLogin,
    options.plan.mainMarker,
    options.change.change.number,
  );
  assertProgressLease(main, options.progressLease);
}

function assertProgressLease(
  comment: GiteaComment | undefined,
  lease: ReviewProgressLease | undefined,
): void {
  if (!lease) return;
  if (
    comment?.id !== lease.mainCommentId ||
    extractReviewProgressToken(comment.body) !== lease.token
  ) {
    throw new ReviewProgressSupersededError();
  }
}

export function giteaCoordinates(change: ChangeRequestEventContext) {
  if (change.coordinates?.provider !== "gitea") {
    throw new Error("Gitea-compatible adapter requires Gitea coordinates");
  }
  return change.coordinates;
}

function giteaReviewCommentLocation(comment: GiteaReviewComment) {
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

function displayName(host: GiteaClient["host"]): string {
  return host === "gitea" ? "Gitea" : host === "forgejo" ? "Forgejo" : "Codeberg";
}
