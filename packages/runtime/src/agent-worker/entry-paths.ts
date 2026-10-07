import path from "node:path";
import { fileURLToPath } from "node:url";

/** Resolves a runtime entry built to `dist/agent-worker/<name>.mjs`, or its source file when running from source. */
export async function agentWorkerEntryPath(name: "main" | "scripted-provider"): Promise<string> {
  const modulePath = fileURLToPath(import.meta.url);
  const moduleDir = path.dirname(modulePath);
  // Running from source resolves source siblings, so a stale build never stands in for the code under test.
  const candidates = modulePath.endsWith(".ts")
    ? [path.join(moduleDir, `${name}.ts`)]
    : [
        path.join(moduleDir, "agent-worker", `${name}.mjs`),
        path.join(moduleDir, `${name}.mjs`),
        path.join(moduleDir, "..", "agent-worker", `${name}.mjs`),
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
