import type { InlinePublicationItem } from "../../review/comment.js";
import type { InlinePublicationLocation } from "../../review/inline-publication-policy.js";
import {
  applyInlineFindingMarkers,
  applyNativeThreadResolutions,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractPriorReviewState,
  type PriorReviewState,
} from "../../review/prior-state.js";
import type { ChangeRequestEventContext } from "../../types.js";
import type { InlineThreadContext } from "../types.js";
import type {
  GitLabClient,
  GitLabDiffRefs,
  GitLabDiscussion,
  GitLabNote,
  GitLabPosition,
} from "./client.js";

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
  return ownedGitLabNote(notes, owner.username, gitLabMainMarker(options.change.change.number))
    ?.body;
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
  return gitLabThreadContexts(discussions, owner.username, false);
}

export function gitLabThreadContexts(
  discussions: GitLabDiscussion[],
  ownerUsername: string,
  ownedRepliesOnly: boolean,
): InlineThreadContext[] {
  return discussions.flatMap((discussion) => {
    const root = discussion.notes[0];
    const marker = root ? extractInlineFindingMarkerRecords([root.body])[0] : undefined;
    if (!root || !marker || root.author?.username !== ownerUsername) return [];
    return [
      {
        findingId: marker.id,
        findingHeadSha: marker.head,
        parentCommentId: root.id,
        parentBody: root.body,
        threadId: discussion.id,
        threadResolved: root.resolved ?? false,
        comments: discussion.notes.flatMap((note) =>
          !ownedRepliesOnly || note.author?.username === ownerUsername
            ? [{ id: note.id, body: note.body, authorLogin: note.author?.username }]
            : [],
        ),
      },
    ];
  });
}

export function gitLabInlineLocationFromDiscussion(
  discussion: GitLabDiscussion,
): InlinePublicationLocation | undefined {
  const root = discussion.notes[0];
  if (!root?.position) return undefined;
  const marker = extractInlineFindingMarkerRecords([root.body])[0];
  if (!marker) return undefined;
  const position = root.position;
  const rightSide = position.new_line !== undefined;
  const endLine = rightSide ? position.new_line : position.old_line;
  if (endLine === undefined) return undefined;
  return {
    path: rightSide ? (position.new_path ?? "") : (position.old_path ?? position.new_path ?? ""),
    commitId: marker.head,
    side: rightSide ? "RIGHT" : "LEFT",
    startLine: rightSide
      ? (position.line_range?.start.new_line ?? endLine)
      : (position.line_range?.start.old_line ?? endLine),
    endLine,
  };
}

export function gitLabInlineLocation(item: InlinePublicationItem): InlinePublicationLocation {
  return {
    path: item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path,
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: item.startLine,
    endLine: item.endLine,
  };
}

export function gitLabPosition(item: InlinePublicationItem, refs: GitLabDiffRefs): GitLabPosition {
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

export function gitLabInlineBody(item: InlinePublicationItem): string {
  const offset = item.endLine - item.startLine;
  return item.body.replaceAll(/(`{3,})suggestion(\r?\n)/g, `$1suggestion:-${offset}+0$2`);
}

export async function assertCurrentGitLabHead(
  client: GitLabClient,
  change: ChangeRequestEventContext,
  reviewedHeadSha = change.change.head.sha,
) {
  const current = await client.getMergeRequest(
    gitLabCoordinates(change).projectId,
    change.change.number,
  );
  if (current.diff_refs.head_sha !== reviewedHeadSha) {
    throw new Error(
      `GitLab merge request head changed from ${reviewedHeadSha} to ${current.diff_refs.head_sha}`,
    );
  }
  return current;
}

export function gitLabCoordinates(change: ChangeRequestEventContext) {
  if (change.coordinates?.provider !== "gitlab")
    throw new Error("GitLab adapter requires GitLab coordinates");
  return change.coordinates;
}

export function ownedGitLabNote(notes: GitLabNote[], username: string, marker: string) {
  return notes.find(
    (note) => note.author?.username === username && note.body.trimStart().startsWith(marker),
  );
}

export function gitLabMainMarker(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}

function discussionNotes(discussions: GitLabDiscussion[]) {
  return discussions.flatMap((discussion) => discussion.notes);
}

function lineRangePoint(path: string, type: "old" | "new", line: number) {
  const hash = new Bun.CryptoHasher("sha1").update(path).digest("hex");
  return {
    line_code: `${hash}_${type === "old" ? line : 0}_${type === "new" ? line : 0}`,
    type,
    ...(type === "old" ? { old_line: line } : { new_line: line }),
  };
}
