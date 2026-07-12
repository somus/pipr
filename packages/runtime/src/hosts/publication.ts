import type { InlinePublicationItem, PublicationMetadata } from "../review/comment.js";
import { extractInlineFindingMarkerRecords } from "../review/prior-state.js";
import { PublicationError, type PublicationResult } from "../review/publication-result.js";

export async function publishUnseenInlineItems(options: {
  items: InlinePublicationItem[];
  existingBodies: string[];
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
    if (existing.has(`${item.findingId}:${item.reviewedHeadSha}`)) {
      skipped += 1;
      continue;
    }
    try {
      await options.publish(item);
      posted += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { posted, skipped, errors };
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
