import type { InlinePublicationItem, PublicationPlan, ThreadAction } from "../../review/comment.js";
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
  assertInlinePublicationComplete,
  commandResponseBody,
  completeHostPublication,
  publishUnseenInlineItems,
} from "../publication.js";
import { retryCodeHostOperation } from "../retry.js";
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
  const inline = await publishUnseenInlineItems({
    items: options.plan.inlineItems,
    existingBodies: ownedBodies,
    reloadExistingBodies: async () =>
      discussionNotes(await options.client.listDiscussions(projectId, options.change.change.number))
        .filter((note) => note.author?.username === owner.username)
        .map((note) => note.body),
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
  });
  assertInlinePublicationComplete({
    provider: "GitLab",
    inline,
    metadata: options.plan.metadata,
  });
  const main = existingMain
    ? await options.client.updateNote(
        projectId,
        options.change.change.number,
        existingMain.id,
        options.plan.mainComment,
      )
    : await retryCodeHostOperation({
        operation: () =>
          options.client.createNote(
            projectId,
            options.change.change.number,
            options.plan.mainComment,
          ),
        reconcile: async () =>
          ownedNote(
            await options.client.listNotes(projectId, options.change.change.number),
            owner.username,
            mainMarker(options.change.change.number),
          ),
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

export async function publishGitLabCommandResponse(options: {
  client: GitLabClient;
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  body: string;
}) {
  const { projectId } = gitLabCoordinates(options.change);
  const owner = await options.client.currentUser();
  const response = commandResponseBody({
    changeNumber: options.change.change.number,
    sourceCommentId: options.sourceCommentId,
    commandName: options.commandName,
    body: options.body,
  });
  const existing = ownedNote(
    await options.client.listNotes(projectId, options.change.change.number),
    owner.username,
    response.marker,
  );
  await assertCurrentHead(options.client, projectId, options.change);
  const note = existing
    ? await options.client.updateNote(
        projectId,
        options.change.change.number,
        existing.id,
        response.body,
      )
    : await retryCodeHostOperation({
        operation: () =>
          options.client.createNote(projectId, options.change.change.number, response.body),
        reconcile: async () =>
          ownedNote(
            await options.client.listNotes(projectId, options.change.change.number),
            owner.username,
            response.marker,
          ),
      });
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
  return applyResolvedFindingMarkers(applyInlineFindingMarkers(state, bodies), bodies);
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
}): Promise<{ errors: string[] }> {
  if (options.actions.length === 0) return { errors: [] };
  const { projectId } = gitLabCoordinates(options.change);
  await assertCurrentHead(options.client, projectId, options.change, options.reviewedHeadSha);
  const discussions =
    options.discussions ??
    (await options.client.listDiscussions(projectId, options.change.change.number));
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
  discussion?: GitLabDiscussion;
}): Promise<string | undefined> {
  if (!options.discussion) {
    return `GitLab discussion not found for comment ${options.action.commentId}`;
  }
  try {
    if (!options.discussion.notes.some((note) => note.body.includes(options.action.responseKey))) {
      await retryCodeHostOperation({
        operation: () =>
          options.client.replyDiscussion(
            options.projectId,
            options.changeNumber,
            options.discussion?.id ?? "",
            options.action.body,
          ),
        reconcile: async () => {
          const discussion = await options.client.getDiscussion(
            options.projectId,
            options.changeNumber,
            options.discussion?.id ?? "",
          );
          return discussion.notes.find((note) => note.body.includes(options.action.responseKey));
        },
      });
    }
    if (options.action.kind === "resolve" && !options.discussion.notes[0]?.resolved) {
      await retryCodeHostOperation({
        idempotent: true,
        operation: () =>
          options.client.resolveDiscussion(
            options.projectId,
            options.changeNumber,
            options.discussion?.id ?? "",
          ),
      });
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
