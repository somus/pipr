import type { CodeHostAdapter } from "../hosts/types.js";
import type { RuntimeActionLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { assertTrustedActionProviderEnv } from "./action-host.js";
import { addProviderSecrets, logPhase, logTrustedRuntime } from "./action-logging.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import type { ActionCommandDependencyOptions, TrustedRuntimeProject } from "./types.js";

export async function loadTrustedRuntimeForEvent(
  options: ActionCommandDependencyOptions,
  event: ChangeRequestEventContext,
  log: RuntimeActionLog,
): Promise<TrustedRuntimeProject> {
  const trustedRuntime = await logPhase(log, "load trusted config", async () =>
    loadRuntimeProjectFromGitCommit({
      rootDir: options.rootDir,
      configDir: options.configDir,
      commitSha: event.change.base.sha,
      env: options.env,
    }),
  );
  logTrustedRuntime(log, trustedRuntime);
  return trustedRuntime;
}

export async function prepareTrustedHeadCheckout(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  config: PiprConfig,
  event: ChangeRequestEventContext,
  log: RuntimeActionLog,
): Promise<void> {
  addProviderSecrets(log, config, options.env);
  assertTrustedActionProviderEnv(options, config);
  await logPhase(log, "checkout head", async () => {
    adapter.workspace.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  });
}
