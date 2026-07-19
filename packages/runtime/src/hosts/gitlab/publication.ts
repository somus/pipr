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
import type { PublicationResult } from "../../review/publication-result.js";
import type { ChangeRequestEventContext } from "../../types.js";
import {
  type CommandResponsePublicationOptions,
  type CommandStatusPublicationOptions,
  commandResponsePublication,
  commandStatusPublication,
  completeHostPublication,
  nativeInlineLocation,
  publishUnseenInlineItems,
  shouldUpdateCommandComment,
  threadActionReply,
} from "../publication.js";
import type { InlineThreadContext } from "../types.js";
import type {
  GitLabClient,
  GitLabDiffRefs,
  GitLabDiscussion,
  GitLabNote,
  GitLabPosition,
} from "./client.js";

export async function publishGitLabPlan(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
  plan: PublicationPlan;
}): Promise<PublicationResult> {
  const { projectId } = gitLabCoordinates(options.change);
  const owner = await options.client.currentUser();
  const notes = await options.client.listNotes(projectId, options.change.change.number);
  const existingMain = ownedNote(notes, owner.username, mainMarker(options.change.change.number));
  const discussions = await options.client.listDiscussions(projectId, options.change.change.number);
  const ownedBodies = discussionNotes(discussions)
    .filter((note) => note.author?.username === owner.username)
    .map((note) => note.body);
  const mergeRequest = await assertCurrentHead(options.client, projectId, options.change);
  const main = existingMain
    ? await options.client.updateNote(
        projectId,
        options.change.change.number,
        existingMain.id,
        options.plan.mainComment,
      )
    : await options.client.createNote(
        projectId,
        options.change.change.number,
        options.plan.mainComment,
      );
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: ownedBodies,
    existingLocations: gitLabInlineLocations(discussions, owner.username),
    location: gitLabInlineLocation,
    publish: async (item) => {
      await options.client.createDiscussion(
        projectId,
        options.change.change.number,
        gitLabInlineBody(item),
        gitLabPosition(item, mergeRequest.diff_refs),
      );
    },
  });
  const resolution = await publishGitLabThreadActions({
    client: options.client,
    change: options.change,
    actions: options.plan.threadActions,
    reviewedHeadSha: options.plan.metadata.reviewedHeadSha,
    discussions,
    ownerUsername: owner.username,
  });
  return completeHostPublication({
    provider: "GitLab",
    mainAction: existingMain ? "updated" : "created",
    mainId: main.id,
    inline,
    resolutionErrors: resolution.errors,
    metadata: options.plan.metadata,
  });
}

function gitLabInlineLocations(
  discussions: GitLabDiscussion[],
  ownerUsername: string,
): InlinePublicationLocation[] {
  const locations: InlinePublicationLocation[] = [];
  for (const discussion of discussions) {
    if (discussion.notes[0]?.author?.username !== ownerUsername) continue;
    const location = gitLabInlineLocationFromDiscussion(discussion);
    if (location) locations.push(location);
  }
  return locations;
}

function gitLabInlineLocationFromDiscussion(
  discussion: GitLabDiscussion,
): InlinePublicationLocation | undefined {
  const root = discussion.notes[0];
  if (!root?.position) return undefined;
  const marker = extractInlineFindingMarkerRecords([root.body])[0];
  if (!marker) return undefined;
  const position = root.position;
  return nativeInlineLocation({
    commitId: marker.head,
    rightPath: position.new_path ?? "",
    leftPath: position.old_path ?? position.new_path ?? "",
    rightStart: position.line_range?.start.new_line ?? undefined,
    rightEnd: position.new_line,
    leftStart: position.line_range?.start.old_line ?? undefined,
    leftEnd: position.old_line,
  });
}

function gitLabInlineLocation(item: InlinePublicationItem): InlinePublicationLocation {
  return {
    path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

export async function publishGitLabCommandResponse(
  options: CommandResponsePublicationOptions<GitLabClient>,
) {
  return await publishGitLabCommandComment({
    client: options.client,
    change: options.change,
    ...commandResponsePublication(options),
  });
}

export async function publishGitLabCommandStatus(
  options: CommandStatusPublicationOptions<GitLabClient>,
) {
  return await publishGitLabCommandComment({
    client: options.client,
    change: options.change,
    ...commandStatusPublication(options),
  });
}

async function publishGitLabCommandComment(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
  guardHead: boolean;
  comment: { marker: string; body: string };
}) {
  const { projectId } = gitLabCoordinates(options.change);
  const owner = await options.client.currentUser();
  const existing = ownedNote(
    await options.client.listNotes(projectId, options.change.change.number),
    owner.username,
    options.comment.marker,
  );
  if (options.guardHead) {
    await assertCurrentHead(options.client, projectId, options.change);
  }
  if (existing && !shouldUpdateCommandComment(existing.body, options.comment.body)) {
    return { action: "updated" as const, id: existing.id };
  }
  const note = existing
    ? await options.client.updateNote(
        projectId,
        options.change.change.number,
        existing.id,
        options.comment.body,
      )
    : await options.client.createNote(
        projectId,
        options.change.change.number,
        options.comment.body,
      );
  return { action: existing ? ("updated" as const) : ("created" as const), id: note.id };
}

export async function loadGitLabPriorReviewState(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
}): Promise<PriorReviewState | undefined> {
  const body = await loadGitLabPriorMainComment(options);
  const state = extractPriorReviewState(body, options.change.change.number);
  if (!state) return undefined;
  const owner = await options.client.currentUser();
  const discussions = await options.client.listDiscussions(
    gitLabCoordinates(options.change).projectId,
    options.change.change.number,
  );
  const bodies = discussionNotes(discussions)
    .filter((note) => note.author?.username === owner.username)
    .map((note) => note.body);
  const markerState = applyResolvedFindingMarkers(applyInlineFindingMarkers(state, bodies), bodies);
  return applyNativeThreadResolutions(
    markerState,
    discussions.flatMap((discussion) => {
      const root = discussion.notes[0];
      const marker = root ? extractInlineFindingMarkerRecords([root.body])[0] : undefined;
      return root && marker && root.author?.username === owner.username
        ? [{ findingId: marker.id, findingHeadSha: marker.head, resolved: root.resolved ?? false }]
        : [];
    }),
  );
}

export async function loadGitLabPriorMainComment(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
}): Promise<string | undefined> {
  const owner = await options.client.currentUser();
  const notes = await options.client.listNotes(
    gitLabCoordinates(options.change).projectId,
    options.change.change.number,
  );
  return ownedNote(notes, owner.username, mainMarker(options.change.change.number))?.body;
}

export async function loadGitLabInlineThreadContexts(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
}): Promise<InlineThreadContext[]> {
  const owner = await options.client.currentUser();
  const discussions = await options.client.listDiscussions(
    gitLabCoordinates(options.change).projectId,
    options.change.change.number,
  );
  return discussions.flatMap((discussion) => {
    const root = discussion.notes[0];
    const marker = root ? extractInlineFindingMarkerRecords([root.body])[0] : undefined;
    if (!root || !marker || root.author?.username !== owner.username) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.body,
        threadId: discussion.id,
        threadResolved: root.resolved ?? false,
        comments: discussion.notes.map((note) => ({
          id: note.id,
          body: note.body,
          authorLogin: note.author?.username,
        })),
      },
    ];
  });
}

export async function publishGitLabThreadActions(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
  actions: ThreadAction[];
  reviewedHeadSha: string;
  discussions?: GitLabDiscussion[];
  ownerUsername?: string;
}): Promise<{ errors: string[] }> {
  if (options.actions.length === 0) return { errors: [] };
  const { projectId } = gitLabCoordinates(options.change);
  await assertCurrentHead(options.client, projectId, options.change, options.reviewedHeadSha);
  const discussions =
    options.discussions ??
    (await options.client.listDiscussions(projectId, options.change.change.number));
  const ownerUsername = options.ownerUsername ?? (await options.client.currentUser()).username;
  await assertCurrentHead(options.client, projectId, options.change, options.reviewedHeadSha);
  const byNote = new Map(
    discussions.flatMap((discussion) => discussion.notes.map((note) => [note.id, discussion])),
  );
  const errors: string[] = [];
  for (const action of options.actions) {
    const error = await publishGitLabThreadAction({
      client: options.client,
      projectId,
      changeNumber: options.change.change.number,
      action,
      ownerUsername,
      discussion: action.threadId
        ? discussions.find((candidate) => candidate.id === action.threadId)
        : byNote.get(action.commentId),
    });
    if (error) errors.push(error);
  }
  return { errors };
}

async function publishGitLabThreadAction(options: {
  client: GitLabClient;
  projectId: string;
  changeNumber: number;
  action: ThreadAction;
  ownerUsername: string;
  discussion?: GitLabDiscussion;
}): Promise<string | undefined> {
  if (!options.discussion) {
    return `GitLab discussion not found for comment ${options.action.commentId}`;
  }
  try {
    const reply = threadActionReply(options.action);
    if (
      !options.discussion.notes.some(
        (note) =>
          note.author?.username === options.ownerUsername && note.body.includes(reply.marker),
      )
    ) {
      await options.client.replyDiscussion(
        options.projectId,
        options.changeNumber,
        options.discussion.id,
        reply.body,
      );
    }
    if (options.action.kind === "resolve" && !options.discussion.notes[0]?.resolved) {
      await options.client.resolveDiscussion(
        options.projectId,
        options.changeNumber,
        options.discussion.id,
      );
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

function gitLabPosition(item: InlinePublicationItem, refs: GitLabDiffRefs): GitLabPosition {
  const oldPath = item.previousPath ?? item.path;
  const position: GitLabPosition = {
    position_type: "text",
    base_sha: refs.base_sha,
    start_sha: refs.start_sha,
    head_sha: refs.head_sha,
    old_path: oldPath,
    new_path: item.path,
    ...(item.side === "RIGHT" ? { new_line: item.endLine } : { old_line: item.endLine }),
  };
  if (item.startLine !== item.endLine) {
    const type = item.side === "RIGHT" ? "new" : "old";
    const linePath = type === "old" ? oldPath : item.path;
    position.line_range = {
      start: lineRangePoint(linePath, type, item.startLine),
      end: lineRangePoint(linePath, type, item.endLine),
    };
  }
  return position;
}

function lineRangePoint(path: string, type: "old" | "new", line: number) {
  const hash = new Bun.CryptoHasher("sha1").update(path).digest("hex");
  return {
    line_code: `${hash}_${type === "old" ? line : 0}_${type === "new" ? line : 0}`,
    type,
    ...(type === "old" ? { old_line: line } : { new_line: line }),
  };
}

function gitLabInlineBody(item: InlinePublicationItem): string {
  const offset = item.endLine - item.startLine;
  return item.body.replaceAll(/(`{3,})suggestion(\r?\n)/g, `$1suggestion:-${offset}+0$2`);
}

async function assertCurrentHead(
  client: GitLabClient,
  projectId: string,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
): Promise<Awaited<ReturnType<GitLabClient["getMergeRequest"]>>> {
  const current = await client.getMergeRequest(projectId, change.change.number);
  if (current.diff_refs.head_sha !== reviewedHeadSha) {
    throw new Error(
      `GitLab merge request head changed from ${reviewedHeadSha} to ${current.diff_refs.head_sha}`,
    );
  }
  return current;
}

function gitLabCoordinates(change: ChangeRequestEventContext) {
  if (change.coordinates?.provider !== "gitlab") {
    throw new Error("GitLab adapter requires GitLab coordinates");
  }
  return change.coordinates;
}

function ownedNote(notes: GitLabNote[], username: string, marker: string): GitLabNote | undefined {
  return notes.find(
    (note) => note.author?.username === username && note.body.trimStart().startsWith(marker),
  );
}

function discussionNotes(discussions: GitLabDiscussion[]) {
  return discussions.flatMap((discussion) => discussion.notes);
}

function mainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}
