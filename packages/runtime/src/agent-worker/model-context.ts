// Reads the pi-ai context a scripted model provider receives. Shared by Pipr's scripted providers for tests, evals, and e2e.
import type { Message } from "@earendil-works/pi-ai";

type MessageContent = Message["content"];

/** Joins a message's text: plain string content as-is, otherwise its text parts in order. */
export function messageText(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

/** System prompt texts in order: each system message's content, then its non-null named sections. */
export function systemPromptTexts(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "system"
      ? [
          messageText(message.content),
          ...Object.values(message.sections ?? {}).filter((text) => text !== null),
        ].filter((text) => text !== "")
      : [],
  );
}

/** Names of the tools system messages made available, in the order they were added. */
export function offeredToolNames(messages: readonly Message[]): string[] {
  return messages.flatMap((message) =>
    message.role === "system" ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
  );
}
