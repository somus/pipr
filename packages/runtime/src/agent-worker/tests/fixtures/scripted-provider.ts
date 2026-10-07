import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

type Message = { role: string; content: unknown };

type Reply = (prompt: string) => ReturnType<typeof fauxAssistantMessage>;

const echoPrompt: Reply = (prompt) =>
  fauxAssistantMessage([fauxText(JSON.stringify({ echo: prompt }))]);

/** Replies to "use-tool" prompts with a `remember` tool call, echoes tool results, and otherwise echoes the prompt. */
const promptReplies: Array<{ keyword: string; reply: Reply }> = [
  {
    keyword: "use-tool",
    reply: () =>
      fauxAssistantMessage([fauxToolCall("remember", { key: "style" })], { stopReason: "toolUse" }),
  },
  { keyword: "crash-worker", reply: () => process.exit(3) },
];

function respond(context: { messages: Message[] }) {
  const last = context.messages.findLast(isConversationMessage) ?? { role: "user", content: "" };
  if (last.role === "toolResult") {
    return fauxAssistantMessage([fauxText(JSON.stringify({ tool: last.content }))]);
  }
  const prompt = JSON.stringify(last.content);
  const match = promptReplies.find(({ keyword }) => prompt.includes(keyword));
  return (match ?? { reply: echoPrompt }).reply(prompt);
}

function isConversationMessage(message: Message): boolean {
  return message.role === "user" || message.role === "toolResult";
}

export default function providers() {
  const faux = fauxProvider({ provider: "fake", models: [{ id: "reviewer" }] });
  faux.setResponses(Array.from({ length: 100 }, () => respond));
  return [faux.provider];
}
