import { ensureCodeHostCommit } from "../hosts/git.js";
import type { CodeHostAdapter } from "../hosts/types.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { assertTrustedHostRunProviderEnv } from "./adapter.js";
import type { HostRunWorkspace } from "./composition.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import { addProviderSecrets, logPhase, logTrustedRuntime } from "./logging.js";
import type { TrustedRuntimeProject } from "./types.js";

export async function loadTrustedRuntimeForEvent(
  workspace: Pick<HostRunWorkspace, "rootDir" | "configDir" | "env">,
  event: ChangeRequestEventContext,
  log: RuntimeLog,
): Promise<TrustedRuntimeProject> {
  await logPhase(log, "fetch trusted base", async () =>
    ensureCodeHostCommit({
      rootDir: workspace.rootDir,
      commitSha: event.change.base.sha,
      fetchRef: event.change.base.ref ?? event.change.base.sha,
      fetchEnv: workspace.env,
    }),
  );
  const trustedRuntime = await logPhase(log, "load trusted config", async () =>
    loadRuntimeProjectFromGitCommit({
      rootDir: workspace.rootDir,
      configDir: workspace.configDir,
      commitSha: event.change.base.sha,
      env: workspace.env,
    }),
  );
  logTrustedRuntime(log, trustedRuntime);
  return trustedRuntime;
}

export async function prepareTrustedHeadCheckout(
  workspace: Pick<HostRunWorkspace, "rootDir" | "env">,
  adapter: CodeHostAdapter,
  config: PiprConfig,
  event: ChangeRequestEventContext,
  log: RuntimeLog,
): Promise<void> {
  addProviderSecrets(log, config, workspace.env);
  assertTrustedHostRunProviderEnv(workspace.env, config);
  await logPhase(log, "checkout head", async () => {
    await adapter.workspace.ensureHeadCheckout({ rootDir: workspace.rootDir, change: event });
  });
}
