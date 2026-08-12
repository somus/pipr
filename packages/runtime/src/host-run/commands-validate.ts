import { validateProject } from "../config/project.js";
import type { RuntimeCommandOptions, ValidateCommandResult } from "./types.js";

/** Loads and validates the runtime project configuration. */
export async function runValidateCommand(
  options: RuntimeCommandOptions,
): Promise<ValidateCommandResult> {
  return (
    await validateProject({
      ...options,
      requireProviderEnv: options.requireProviderEnv ?? false,
    })
  ).settings;
}
