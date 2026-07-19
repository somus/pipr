import type {
  InlinePublicationItem,
  PublicationMetadata,
  ThreadAction,
} from "../review/comment.js";
import {
  type InlinePublicationLocation,
  inlinePublicationDecision,
} from "../review/inline-publication-policy.js";
import {
  extractInlineFindingMarkerRecords,
  renderResolvedFindingMarker,
  renderVerifierResponseMarker,
} from "../review/prior-state.js";
import { PublicationError, type PublicationResult } from "../review/publication-result.js";
import type { ChangeRequestEventContext } from "../types.js";
import type { CommandLifecycleState } from "./types.js";

export type CommandResponsePublicationOptions<Client> = {
  client: Client;
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  body: string;
};

export type CommandStatusPublicationOptions<Client> = {
  client: Client;
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  state: CommandLifecycleState;
  reviewedHeadSha: string;
  currentHeadSha?: string;
};

export async function publishUnseenInlineItems(options: {
  items: InlinePublicationItem[];
  existingBodies: string[];
  existingLocations?: InlinePublicationLocation[];
  location?(item: InlinePublicationItem): InlinePublicationLocation;
  publish(item: InlinePublicationItem): Promise<unknown>;
}): Promise<{ posted: number; skipped: number; errors: string[] }> {
  const existing = new Set(
    extractInlineFindingMarkerRecords(options.existingBodies).map(
      (record) => `${record.id}:${record.head}`,
    ),
  );
  const errors: string[] = [];
  let posted = 0;
  let skipped = 0;
  for (const item of options.items) {
    const marker = `${item.findingId}:${item.reviewedHeadSha}`;
    const location = options.location?.(item);
    if (
      existing.has(marker) ||
      (location !== undefined &&
        inlinePublicationDecision({
          marker,
          location,
          existing: {
            markers: existing,
            locations: options.existingLocations ?? [],
          },
        }) === "skip")
    ) {
      skipped += 1;
      continue;
    }
    try {
      await options.publish(item);
      posted += 1;
      existing.add(marker);
      if (location) options.existingLocations?.push(location);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { posted, skipped, errors };
}

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

export function commandResponseBody(options: {
  changeNumber: number;
  sourceCommentId: string;
  commandName: string;
  body: string;
  reviewedHeadSha: string;
}): { marker: string; body: string } {
  const marker = commandCommentMarker(options);
  return {
    marker,
    body: [
      marker,
      commandStateMarker({ state: "completed", reviewedHeadSha: options.reviewedHeadSha }),
      "",
      options.body,
      "",
    ].join("\n"),
  };
}

export function commandStatusBody(options: {
  changeNumber: number;
  sourceCommentId: string;
  commandName: string;
  state: CommandLifecycleState;
  reviewedHeadSha: string;
  currentHeadSha?: string;
}): { marker: string; body: string } {
  const marker = commandCommentMarker(options);
  return {
    marker,
    body: [marker, commandStateMarker(options), "", commandStatusMessage(options), ""].join("\n"),
  };
}

export function shouldUpdateCommandComment(existingBody: string, nextBody: string): boolean {
  const next = commandStateRecord(nextBody);
  if (next?.state !== "failed" && next?.state !== "superseded") return true;
  const existing = commandStateRecord(existingBody);
  return existing === undefined || existing.reviewedHeadSha === next.reviewedHeadSha;
}

export function commandResponsePublication(options: CommandResponsePublicationOptions<unknown>): {
  guardHead: true;
  comment: { marker: string; body: string };
} {
  return {
    guardHead: true,
    comment: commandResponseBody({
      changeNumber: options.change.change.number,
      sourceCommentId: options.sourceCommentId,
      commandName: options.commandName,
      reviewedHeadSha: options.change.change.head.sha,
      body: options.body,
    }),
  };
}

export function commandStatusPublication(options: CommandStatusPublicationOptions<unknown>): {
  guardHead: false;
  comment: { marker: string; body: string };
} {
  return {
    guardHead: false,
    comment: commandStatusBody({
      changeNumber: options.change.change.number,
      sourceCommentId: options.sourceCommentId,
      commandName: options.commandName,
      state: options.state,
      reviewedHeadSha: options.reviewedHeadSha,
      currentHeadSha: options.currentHeadSha,
    }),
  };
}

function commandCommentMarker(options: {
  changeNumber: number;
  sourceCommentId: string;
  commandName: string;
}): string {
  return `<!-- pipr:command-response change=${options.changeNumber} source=${options.sourceCommentId} command=${options.commandName} -->`;
}

function commandStateMarker(options: {
  state: CommandLifecycleState;
  reviewedHeadSha: string;
  currentHeadSha?: string;
}): string {
  const current = options.currentHeadSha ? ` current=${options.currentHeadSha}` : "";
  return `<!-- pipr:command-state state=${options.state} head=${options.reviewedHeadSha}${current} -->`;
}

function commandStateRecord(
  body: string,
): { state: CommandLifecycleState; reviewedHeadSha: string } | undefined {
  const match = body.match(
    /^<!-- pipr:command-state state=(accepted|running|completed|failed|superseded) head=([^\s>]+)(?: current=[^\s>]+)? -->$/m,
  );
  if (!match?.[1] || !match[2]) return undefined;
  return { state: match[1] as CommandLifecycleState, reviewedHeadSha: match[2] };
}

function commandStatusMessage(options: {
  commandName: string;
  state: CommandLifecycleState;
  reviewedHeadSha: string;
  currentHeadSha?: string;
}): string {
  const command = `\`@pipr ${options.commandName}\``;
  const reviewedHead = `\`${options.reviewedHeadSha.slice(0, 12)}\``;
  switch (options.state) {
    case "accepted":
      return `Pipr accepted ${command} for head ${reviewedHead}.`;
    case "running":
      return `Pipr is running ${command} for head ${reviewedHead}.`;
    case "completed":
      return `Pipr completed ${command} for head ${reviewedHead}.`;
    case "failed":
      return `Pipr could not complete ${command} for head ${reviewedHead}; see logs for details.`;
    case "superseded":
      return `Pipr stopped ${command} because head ${reviewedHead} was superseded by \`${(
        options.currentHeadSha ?? "unknown"
      ).slice(0, 12)}\`. Run the command again on the latest head.`;
    default:
      options.state satisfies never;
      throw new Error("Unsupported command lifecycle state");
  }
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

export function completeHostPublication(options: {
  provider: string;
  mainAction: "created" | "updated";
  mainId: string;
  inline: { posted: number; skipped: number; errors: string[] };
  resolutionErrors: string[];
  metadata: PublicationMetadata;
}): PublicationResult {
  const partial = {
    inlineComments: {
      posted: options.inline.posted,
      skipped: options.inline.skipped,
      failed: options.inline.errors.length,
    },
    metadata: {
      ...options.metadata,
      inlinePublicationErrors: options.inline.errors,
      inlineResolutionErrors: options.resolutionErrors,
    },
  };
  if (options.inline.errors.length > 0) {
    throw new PublicationError(`${options.provider} inline comment publication failed`, partial);
  }
  return {
    mainComment: { action: options.mainAction, id: options.mainId },
    ...partial,
  };
}
