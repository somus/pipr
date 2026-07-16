import { ensureCodeHostCommit } from "../hosts/git.js";
import type { CodeHostAdapter } from "../hosts/types.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { assertTrustedHostRunProviderEnv } from "./adapter.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import { addProviderSecrets, logPhase, logTrustedRuntime } from "./logging.js";
import type { HostRunCommandDependencyOptions, TrustedRuntimeProject } from "./types.js";

export async function loadTrustedRuntimeForEvent(
  options: HostRunCommandDependencyOptions,
  event: ChangeRequestEventContext,
  log: RuntimeLog,
): Promise<TrustedRuntimeProject> {
  await logPhase(log, "fetch trusted base", async () =>
    ensureCodeHostCommit({
      rootDir: options.rootDir,
      commitSha: event.change.base.sha,
      fetchRef: event.change.base.ref ?? event.change.base.sha,
      fetchEnv: options.env,
    }),
  );
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
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  config: PiprConfig,
  event: ChangeRequestEventContext,
  log: RuntimeLog,
): Promise<void> {
  addProviderSecrets(log, config, options.env);
  assertTrustedHostRunProviderEnv(options, config);
  await logPhase(log, "checkout head", async () => {
    await adapter.workspace.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  });
}
