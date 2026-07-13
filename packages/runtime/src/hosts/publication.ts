import type {
  InlinePublicationItem,
  PublicationMetadata,
  ThreadAction,
} from "../review/comment.js";
import {
  extractInlineFindingMarkerRecords,
  renderVerifierResponseMarker,
} from "../review/prior-state.js";
import { PublicationError, type PublicationResult } from "../review/publication-result.js";
import { retryCodeHostOperation } from "./retry.js";

export async function publishUnseenInlineItems(options: {
  items: InlinePublicationItem[];
  existingBodies: string[];
  publish(item: InlinePublicationItem): Promise<unknown>;
  reloadExistingBodies?: () => Promise<string[]>;
  sleep?: (milliseconds: number) => Promise<void>;
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
    const key = `${item.findingId}:${item.reviewedHeadSha}`;
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    try {
      await retryCodeHostOperation({
        operation: async () => {
          await options.publish(item);
          return true;
        },
        reconcile: options.reloadExistingBodies
          ? async () => {
              const records = extractInlineFindingMarkerRecords(
                (await options.reloadExistingBodies?.()) ?? [],
              );
              for (const record of records) existing.add(`${record.id}:${record.head}`);
              return existing.has(key) ? true : undefined;
            }
          : undefined,
        sleep: options.sleep,
      });
      existing.add(key);
      posted += 1;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { posted, skipped, errors };
}

export function assertInlinePublicationComplete(options: {
  provider: string;
  inline: { posted: number; skipped: number; errors: string[] };
  metadata: PublicationMetadata;
}): void {
  if (options.inline.errors.length === 0) return;
  throw new PublicationError(`${options.provider} inline comment publication failed`, {
    inlineComments: {
      posted: options.inline.posted,
      skipped: options.inline.skipped,
      failed: options.inline.errors.length,
    },
    metadata: {
      ...options.metadata,
      inlinePublicationErrors: options.inline.errors,
      inlineResolutionErrors: [],
    },
  });
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

export function threadActionReplyBody(action: ThreadAction): string {
  return [
    renderVerifierResponseMarker(action.findingId, action.responseKey),
    "",
    action.body.replaceAll("<!--", "&lt;!--"),
  ].join("\n");
}

export function completeHostPublication(options: {
  provider: string;
  mainAction: "created" | "updated";
  mainId: string;
  inline: { posted: number; skipped: number; errors: string[] };
  resolutionErrors: string[];
  metadata: PublicationMetadata;
}): PublicationResult {
  assertInlinePublicationComplete(options);
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
  return {
    mainComment: { action: options.mainAction, id: options.mainId },
    ...partial,
  };
}
