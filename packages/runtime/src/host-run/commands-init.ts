import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import type { InitCommandOptions } from "./types.js";

/** Initializes the official minimal `.pipr` project files. */
export async function runInitCommand(
  options: InitCommandOptions,
): Promise<InitOfficialMinimalProjectResult> {
  return await initOfficialMinimalProject({
    rootDir: options.rootDir,
    configDir: options.configDir,
    force: options.force,
    adapters: options.adapters,
    recipe: options.recipe,
    minimal: options.minimal,
    runtimeImage: options.runtimeImage,
    checkoutAction: options.checkoutAction,
    githubRunner: options.githubRunner,
    githubEnterpriseServer: options.githubEnterpriseServer,
  });
}
