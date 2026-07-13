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
}): { marker: string; body: string } {
  const marker = `<!-- pipr:command-response change=${options.changeNumber} source=${options.sourceCommentId} command=${options.commandName} -->`;
  return { marker, body: [marker, "", options.body, ""].join("\n") };
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
