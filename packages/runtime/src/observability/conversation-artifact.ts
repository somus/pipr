import type { RunBundleArtifact } from "@usepipr/sdk";
import type { RunConversationEntry } from "./types.js";

type ConversationCounts = NonNullable<RunBundleArtifact["counts"]>;

const maxCountedKinds = 32;
const maxCountedTools = 64;
const maxCountedNameLength = 200;

/**
 * The conversation as JSON Lines, one harness entry per line, with content-free counts of entries, entry kinds, and
 * tool calls. Counts describe the entries the worker returned, even when the stored body is later truncated.
 */
export function conversationArtifact(entries: readonly RunConversationEntry[]): {
  content: string;
  counts: ConversationCounts;
} {
  const kinds = new Map<string, number>();
  const tools = new Map<string, number>();
  for (const entry of entries) {
    increment(kinds, entry.kind);
    for (const name of toolCallNames(entry)) increment(tools, name);
  }
  return {
    content: entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    counts: {
      entries: entries.length,
      byKind: boundedCounts(kinds, maxCountedKinds),
      tools: boundedCounts(tools, maxCountedTools),
    },
  };
}

function toolCallNames(entry: RunConversationEntry): string[] {
  if (!Array.isArray(entry.model)) return [];
  return entry.model.flatMap((message: unknown) => {
    if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }
    return message.content.flatMap((block: unknown) =>
      isRecord(block) && block.type === "toolCall" && typeof block.name === "string" && block.name
        ? [block.name]
        : [],
    );
  });
}

function increment(counts: Map<string, number>, name: string): void {
  const key = name.slice(0, maxCountedNameLength);
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

/** The most frequent names, up to `limit`, so a descriptor stays bounded. */
function boundedCounts(counts: Map<string, number>, limit: number): Record<string, number> {
  return Object.fromEntries(
    [...counts]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, limit),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
