import { Buffer } from "node:buffer";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentRunConversationRecord } from "./protocol.js";

/** Bound on the serialized entries a run outcome carries; the oldest entries are dropped first. */
const maxConversationBytes = 8 * 1024 * 1024;
const conversationPageSize = 100;

/** The part of a harness conversation that pages its committed entries, newest first. */
type ConversationEntries<Cursor> = {
  entries(
    query: object,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<{ items: readonly unknown[]; next?: Cursor }>;
};

/**
 * The conversation's committed, fork-aware history, oldest first, bounded to `maxConversationBytes`. Capture is
 * diagnostic and best effort: a store failure returns no conversation rather than replacing the run's outcome.
 */
export async function captureConversation<Cursor>(
  conversation: ConversationEntries<Cursor>,
): Promise<AgentRunConversationRecord | undefined> {
  try {
    return await readConversation(conversation);
  } catch {
    return undefined;
  }
}

async function readConversation<Cursor>(
  conversation: ConversationEntries<Cursor>,
): Promise<AgentRunConversationRecord> {
  const newestFirst: AgentRunConversationRecord["entries"] = [];
  let bytes = 0;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({}, conversationPageSize, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      bytes += Buffer.byteLength(JSON.stringify(entry), "utf8");
      if (bytes > maxConversationBytes) {
        return { entries: newestFirst.reverse(), truncated: true };
      }
      newestFirst.push(entry as AgentRunConversationRecord["entries"][number]);
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return { entries: newestFirst.reverse(), truncated: false };
}
