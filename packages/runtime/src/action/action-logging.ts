import type { RuntimeActionLog } from "../shared/logging.js";
import { shortSha } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import type { TrustedRuntimeProject } from "./types.js";

export async function logPhase<T>(
  log: RuntimeActionLog,
  name: string,
  run: () => Promise<T> | T,
): Promise<T> {
  const started = Date.now();
  log.info(`${name} start`);
  try {
    const result = await run();
    log.info(`${name} ok`, { durationMs: Date.now() - started });
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error(`${name} failed`, { durationMs: Date.now() - started, error: message });
    if (log.debugEnabled && error instanceof Error && error.stack) {
      log.text("debug", "error stack", error.stack);
    }
    throw error;
  }
}

export function logEventContext(log: RuntimeActionLog, event: ChangeRequestEventContext): void {
  log.notice("event", {
    platform: event.platform.id,
    eventName: event.eventName,
    action: event.action,
    rawAction: event.rawAction,
    repo: event.repository.slug,
    change: event.change.number,
    base: shortSha(event.change.base.sha),
    head: shortSha(event.change.head.sha),
    fork: event.change.isFork,
  });
}

export function logTrustedRuntime(log: RuntimeActionLog, runtime: TrustedRuntimeProject): void {
  log.notice("trusted config", {
    source: runtime.settings.source,
    trustedConfigSha: shortSha(runtime.trustedConfigSha),
    trustedConfigHash: runtime.trustedConfigHash.slice(0, 12),
    providers: runtime.settings.config.providers
      .map((provider) => `${provider.id}:${provider.model}`)
      .join(","),
    tasks: runtime.plan.tasks.length,
    commands: runtime.plan.commands.length,
  });
}

export function addProviderSecrets(
  log: RuntimeActionLog,
  config: PiprConfig,
  env: NodeJS.ProcessEnv | undefined,
): void {
  for (const provider of config.providers) {
    log.addSecret((env ?? process.env)[provider.apiKeyEnv]);
  }
}
