import type { InlinePublicationItem, ThreadAction } from "../publication/types.js";
import {
  parseMainCommentIdentity,
  renderResolvedFindingMarker,
  renderVerifierResponseMarker,
} from "../review/comment-markers.js";
import type { InlinePublicationLocation } from "../review/inline-publication-policy.js";
import type { CommandLifecycleState } from "./types.js";

export function nativeInlineLocation(options: {
  commitId: string;
  rightPath: string;
  leftPath: string;
  rightStart?: number;
  rightEnd?: number;
  leftStart?: number;
  leftEnd?: number;
}): InlinePublicationLocation | undefined {
  const rightSide = options.rightEnd !== undefined;
  const endLine = rightSide ? options.rightEnd : options.leftEnd;
  if (endLine === undefined) return undefined;
  return {
    path: rightSide ? options.rightPath : options.leftPath,
    commitId: options.commitId,
    side: rightSide ? "RIGHT" : "LEFT",
    startLine: (rightSide ? options.rightStart : options.leftStart) ?? endLine,
    endLine,
  };
}

/** The file path an inline item anchors to: the previous path for LEFT-side renames. */
export function inlineItemPath(item: InlinePublicationItem): string {
  return item.side === "LEFT" ? (item.previousPath ?? item.path) : item.path;
}

/** The location an inline item will occupy; `singleLine` anchors to the end line only. */
export function planInlineLocation(
  item: InlinePublicationItem,
  options: { singleLine?: boolean } = {},
): InlinePublicationLocation {
  return {
    path: inlineItemPath(item),
    commitId: item.reviewedHeadSha,
    side: item.side,
    startLine: options.singleLine ? item.endLine : item.startLine,
    endLine: item.endLine,
  };
}

/** Prefix that starts a main review comment for hosts that match main comments by prefix. */
export function mainCommentPrefix(changeNumber: number): string {
  return `<!-- pipr:main-comment change=${changeNumber} `;
}

/** Whether a comment's first non-empty line identifies the main comment for this change. */
export function isMainCommentLine(
  firstLine: string | undefined,
  marker: string,
  changeNumber: number,
): boolean {
  const identity = parseMainCommentIdentity(firstLine);
  return identity?.marker === marker && identity.changeNumber === changeNumber;
}

export function commandResponseBody(options: {
  changeNumber: number;
  sourceCommentId: string;
  commandName: string;
  body: string;
}): { marker: string; body: string } {
  const marker = `<!-- pipr:command-response change=${options.changeNumber} source=${options.sourceCommentId} command=${options.commandName} -->`;
  return { marker, body: [marker, "", options.body, ""].join("\n") };
}

export function commandStatusText(options: {
  state: CommandLifecycleState;
  reviewedHeadSha: string;
}): string {
  const labels: Record<CommandLifecycleState, string> = {
    accepted: "Pipr accepted this command.",
    running: "Pipr is running this command.",
    completed: "Pipr completed this command.",
    failed: "Pipr could not complete this command; see the run log for details.",
    superseded: "Pipr stopped because the change request head was updated.",
  };
  const marker = `<!-- pipr:command-state state=${options.state} head=${options.reviewedHeadSha} -->`;
  return [marker, "", labels[options.state]].join("\n");
}

export function threadActionReply(action: ThreadAction): { body: string; marker: string } {
  const marker =
    action.kind === "resolve"
      ? renderResolvedFindingMarker(action.findingId, action.findingHeadSha)
      : renderVerifierResponseMarker(action.findingId, action.responseKey);
  return {
    marker,
    body: [marker, "", action.body.replaceAll("<!--", "&lt;!--")].join("\n"),
  };
}
