// Internal provider module for scripted model fixtures in Pipr's own tests, evals, and e2e runs. Not user API.
import { appendFileSync } from "node:fs";
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Provider,
} from "@earendil-works/pi-ai";
import { z } from "zod";

const scriptedResponseSchema = z.union([
  z.strictObject({ text: z.string(), delayMs: z.number().int().nonnegative().optional() }),
  z.strictObject({
    toolCalls: z
      .array(z.strictObject({ name: z.string().min(1), args: z.record(z.string(), z.unknown()) }))
      .min(1),
  }),
  /** Supports `${env:NAME}` interpolation from the worker environment. */
  z.strictObject({ error: z.string().min(1) }),
]);

const scriptedRuleSchema = z.strictObject({
  when: z.strictObject({
    model: z.string().min(1).optional(),
    promptIncludes: z.string().min(1).optional(),
  }),
  response: scriptedResponseSchema,
});

const scriptedProviderScriptSchema = z.strictObject({
  /** `provider/model` refs to serve; refs sharing a provider share one scripted provider. */
  models: z.array(z.string().regex(/^[^/]+\/.+$/)).min(1),
  /** Answers in call order; the last one repeats once the script is exhausted. */
  responses: z.array(scriptedResponseSchema).min(1),
  /** Checked before `responses`; the first rule whose conditions all match answers the call. */
  rules: z.array(scriptedRuleSchema).optional(),
  /** Appends one JSON line per model call with the system prompt and message texts the model received. */
  recordPath: z.string().min(1).optional(),
});

export type ScriptedProviderScript = z.infer<typeof scriptedProviderScriptSchema>;
export type ScriptedResponse = z.infer<typeof scriptedResponseSchema>;

export type ScriptedModelCall = {
  model: string;
  system: string[];
  tools: string[];
  messages: Array<{ role: string; text: string }>;
};

type ContextMessage = { role: string; content?: unknown; sections?: unknown; toolsAdded?: unknown };

export default async function scriptedProviders(configPath: unknown): Promise<Provider[]> {
  if (typeof configPath !== "string") {
    throw new Error("scripted provider module requires a --provider-config script path");
  }
  const script = scriptedProviderScriptSchema.parse(await Bun.file(configPath).json());
  let callIndex = 0;
  const respond = async (
    context: { messages: readonly ContextMessage[] },
    modelRef: string,
    signal: AbortSignal | undefined,
  ) => {
    const call = modelCall(context.messages, modelRef);
    if (script.recordPath) {
      appendFileSync(script.recordPath, `${JSON.stringify(call)}\n`);
    }
    const rule = script.rules?.find((candidate) => ruleMatches(candidate.when, call));
    if (rule) return await scriptedMessage(rule.response, signal);
    const response = script.responses[
      Math.min(callIndex, script.responses.length - 1)
    ] as ScriptedResponse;
    callIndex += 1;
    return await scriptedMessage(response, signal);
  };
  return [...modelsByProvider(script.models)].map(([provider, models]) => {
    const faux = fauxProvider({ provider, models: models.map((id) => ({ id })) });
    faux.setResponses(
      Array.from(
        { length: 1000 },
        () => (context, options, _state, model) =>
          respond(context, `${provider}/${model.id}`, options?.signal),
      ),
    );
    return faux.provider;
  });
}

function modelsByProvider(refs: readonly string[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const ref of refs) {
    const slash = ref.indexOf("/");
    const provider = ref.slice(0, slash);
    grouped.set(provider, [...(grouped.get(provider) ?? []), ref.slice(slash + 1)]);
  }
  return grouped;
}

function ruleMatches(
  when: z.infer<typeof scriptedRuleSchema>["when"],
  call: ScriptedModelCall,
): boolean {
  if (when.model !== undefined && when.model !== call.model) return false;
  if (when.promptIncludes !== undefined) {
    const prompt = call.messages.findLast((message) => message.role === "user")?.text ?? "";
    if (!prompt.includes(when.promptIncludes)) return false;
  }
  return true;
}

async function scriptedMessage(
  response: ScriptedResponse,
  signal: AbortSignal | undefined,
): Promise<AssistantMessage> {
  if ("error" in response) {
    return fauxAssistantMessage([], { stopReason: "error", errorMessage: withEnv(response.error) });
  }
  if ("toolCalls" in response) {
    return fauxAssistantMessage(
      response.toolCalls.map((call) => fauxToolCall(call.name, call.args as never)),
      { stopReason: "toolUse" },
    );
  }
  if (response.delayMs && !(await abortableDelay(response.delayMs, signal))) {
    return fauxAssistantMessage([], { stopReason: "aborted" });
  }
  return fauxAssistantMessage([fauxText(response.text)]);
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return false;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve(false);
      },
      { once: true },
    );
  });
}

/** Expands `${env:NAME}` so fixtures can prove provider errors carrying secrets get redacted. */
function withEnv(text: string): string {
  return text.replace(
    /\$\{env:([A-Za-z0-9_]+)\}/g,
    (_match, name: string) => process.env[name] ?? "",
  );
}

function modelCall(messages: readonly ContextMessage[], model: string): ScriptedModelCall {
  return {
    model,
    system: messages.flatMap((message) =>
      message.role === "system" ? sectionTexts(message.sections) : [],
    ),
    tools: messages.flatMap((message) =>
      message.role === "system" ? toolNames(message.toolsAdded) : [],
    ),
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, text: contentText(message.content) })),
  };
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) =>
    typeof tool === "object" && tool !== null && typeof Reflect.get(tool, "name") === "string"
      ? [Reflect.get(tool, "name") as string]
      : [],
  );
}

function sectionTexts(sections: unknown): string[] {
  if (!Array.isArray(sections)) return [];
  return sections.flatMap((section) =>
    typeof section === "object" &&
    section !== null &&
    typeof Reflect.get(section, "content") === "string"
      ? [Reflect.get(section, "content") as string]
      : [],
  );
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && typeof Reflect.get(part, "text") === "string"
        ? (Reflect.get(part, "text") as string)
        : "",
    )
    .join("");
}
