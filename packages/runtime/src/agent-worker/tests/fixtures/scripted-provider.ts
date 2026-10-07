import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

type Message = { role: string; content: unknown };

/** Replies to "use-tool" prompts with a `remember` tool call, echoes tool results, and otherwise echoes the prompt. */
function respond(context: { messages: Message[] }) {
  const last = context.messages.findLast(
    (message) => message.role === "user" || message.role === "toolResult",
  );
  if (last?.role === "toolResult") {
    return fauxAssistantMessage([fauxText(JSON.stringify({ tool: last.content }))]);
  }
  const prompt = JSON.stringify(last?.content ?? "");
  if (prompt.includes("use-tool")) {
    return fauxAssistantMessage([fauxToolCall("remember", { key: "style" })], {
      stopReason: "toolUse",
    });
  }
  if (prompt.includes("crash-worker")) {
    process.exit(3);
  }
  return fauxAssistantMessage([fauxText(JSON.stringify({ echo: prompt }))]);
}

export default function providers() {
  const faux = fauxProvider({ provider: "fake", models: [{ id: "reviewer" }] });
  faux.setResponses(Array.from({ length: 100 }, () => respond));
  return [faux.provider];
}
