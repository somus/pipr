import { registerProviderSecrets } from "../config/provider-credentials.js";
import { ensureCodeHostCommit } from "../hosts/git.js";
import type { CodeHostAdapter, CommandCommentEvent } from "../hosts/types.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import { assertTrustedHostRunProviderEnv } from "./adapter.js";
import type { HostRunServices, HostRunWorkspace } from "./composition.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import { logEventContext, logPhase, logTrustedRuntime } from "./logging.js";
import type { TrustedRuntimeProject } from "./types.js";

/** The change request coordinates shared by command comments and review comment replies. */
export type CommentChangeRequestSource = Pick<
  CommandCommentEvent,
  "repository" | "changeNumber" | "workspace" | "eventName" | "action" | "rawAction"
>;

/** Loads the current change request a comment targets. */
export function loadCommentChangeRequestRef(
  adapter: CodeHostAdapter,
  source: CommentChangeRequestSource,
) {
  return adapter.events.loadChangeRequest({
    repository: source.repository,
    changeNumber: source.changeNumber,
    workspace: source.workspace,
    eventName: source.eventName,
    action: source.action,
    rawAction: source.rawAction,
  });
}

/** Loads, parses, and logs the change request event a comment targets. */
export async function loadCommentChangeRequest(
  services: HostRunServices,
  source: CommentChangeRequestSource,
): Promise<ChangeRequestEventContext> {
  const loaded = await logPhase(services.log, "load change request", async () =>
    loadCommentChangeRequestRef(services.adapter, source),
  );
  const event = parseChangeRequestEventContext({
    eventName: loaded.eventName ?? source.eventName,
    action: loaded.action ?? source.action,
    rawAction: loaded.rawAction ?? source.rawAction,
    platform: { id: services.adapter.id },
    repository: loaded.repository,
    coordinates: loaded.coordinates,
    change: loaded.change,
    workspace: loaded.workspace ?? source.workspace,
  });
  logEventContext(services.log, event);
  return event;
}

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
  registerProviderSecrets(config.providers, workspace.env, { log });
  assertTrustedHostRunProviderEnv(workspace.env, config);
  await logPhase(log, "checkout head", async () => {
    await adapter.workspace.ensureHeadCheckout({ rootDir: workspace.rootDir, change: event });
  });
}
