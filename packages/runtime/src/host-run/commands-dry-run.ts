import { loadRuntimeProject } from "../config/project.js";
import { createHostRunAdapter } from "./adapter.js";
import type { DryRunCommandOptions, DryRunCommandResult } from "./types.js";

/** Loads the runtime config and change request event without running review publication. */
export async function runDryRunCommand(
  options: DryRunCommandOptions,
): Promise<DryRunCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  const adapter = createHostRunAdapter(options);
  const hostEvent = await adapter.events.parseEvent({
    eventPath: options.eventPath,
    env: options.env ?? process.env,
    workspace: options.rootDir,
  });
  if (hostEvent.kind !== "change-request") {
    throw new Error(`dry-run requires a change-request event, received ${hostEvent.kind}`);
  }
  const event = hostEvent.change;
  return {
    configSource: runtime.settings.source,
    event,
    warnings: runtime.settings.warnings,
  };
}
