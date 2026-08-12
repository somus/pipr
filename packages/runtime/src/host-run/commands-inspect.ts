import { inspectRuntimePlan, loadRuntimeProject } from "../config/project.js";
import type { InspectCommandResult, RuntimeCommandOptions } from "./types.js";

/** Returns an inspectable summary of the configured runtime plan. */
export async function runInspectCommand(
  options: RuntimeCommandOptions,
): Promise<InspectCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return {
    ...inspectRuntimePlan(runtime.plan, runtime.settings.source),
    warnings: runtime.settings.warnings,
  };
}
