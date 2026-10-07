import { rm } from "node:fs/promises";
import path from "node:path";
import { scriptedProviderModulePath } from "../../agent-worker/entry-paths.js";
import type {
  ScriptedModelCall,
  ScriptedProviderScript,
  ScriptedResponse,
} from "../../agent-worker/scripted-provider.js";
import type { PiProviderModule } from "../../pi/types.js";

/** Model refs used by runtime test configs; the scripted provider replaces these providers. */
const scriptedTestModels = [
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-fallback",
  "deepseek/deepseek-v4",
  "deepseek/deepseek-reasoner",
  "openai-codex/gpt-5.5",
  "fake/reviewer",
];

export type ScriptedPi = {
  providerModule: PiProviderModule;
  /** Replaces the script; agent workers read it when they start, so it applies from the next run. */
  script(update: Partial<Omit<ScriptedProviderScript, "recordPath">>): Promise<void>;
  answer(...texts: string[]): Promise<void>;
  fail(error: string): Promise<void>;
  calls(): Promise<ScriptedModelCall[]>;
  /** The last user message of each model call, in call order. */
  prompts(): Promise<string[]>;
  reset(): Promise<void>;
};

export async function createScriptedPi(
  directory: string,
  initial: Partial<Omit<ScriptedProviderScript, "recordPath">> = {},
): Promise<ScriptedPi> {
  const scriptPath = path.join(directory, "scripted-pi.json");
  const recordPath = path.join(directory, "scripted-pi-calls.jsonl");
  const write = async (update: Partial<Omit<ScriptedProviderScript, "recordPath">>) => {
    const script: ScriptedProviderScript = {
      models: update.models ?? scriptedTestModels,
      responses: update.responses ?? [
        { text: '{"summary":{"body":"No findings."},"inlineFindings":[]}' },
      ],
      ...(update.rules ? { rules: update.rules } : {}),
      recordPath,
    };
    await Bun.write(scriptPath, JSON.stringify(script));
  };
  await write(initial);
  const calls = async (): Promise<ScriptedModelCall[]> => {
    const file = Bun.file(recordPath);
    if (!(await file.exists())) return [];
    return (await file.text())
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ScriptedModelCall);
  };
  return {
    providerModule: { path: await scriptedProviderModulePath(), config: scriptPath },
    script: write,
    async answer(...texts) {
      await write({ responses: texts.map((text): ScriptedResponse => ({ text })) });
    },
    async fail(error) {
      await write({ responses: [{ error }] });
    },
    calls,
    async prompts() {
      return (await calls()).map(
        (call) => call.messages.findLast((message) => message.role === "user")?.text ?? "",
      );
    },
    async reset() {
      await rm(recordPath, { force: true });
    },
  };
}
