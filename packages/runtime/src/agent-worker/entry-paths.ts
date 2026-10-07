import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves a runtime entry built to `dist/agent-worker/<name>.mjs`, or its source file when running from source. */
export async function agentWorkerEntryPath(name: "main" | "scripted-provider"): Promise<string> {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDir, "agent-worker", `${name}.mjs`),
    path.join(moduleDir, `${name}.mjs`),
    path.join(moduleDir, "..", "agent-worker", `${name}.mjs`),
    path.join(moduleDir, "..", "..", "dist", "agent-worker", `${name}.mjs`),
    path.join(moduleDir, `${name}.ts`),
  ];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) {
      return candidate;
    }
  }
  throw new Error(`Unable to locate the pipr agent worker '${name}' entry`);
}

/** Provider module for scripted model fixtures; pass a `ScriptedProviderScript` JSON file as its config. */
export async function scriptedProviderModulePath(): Promise<string> {
  return await agentWorkerEntryPath("scripted-provider");
}
