import type { RuntimeLog } from "../shared/logging.js";
import { shortSha } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import type { TrustedRuntimeProject } from "./types.js";

export async function logPhase<T>(
  log: RuntimeLog,
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

export function logEventContext(log: RuntimeLog, event: ChangeRequestEventContext): void {
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

export function logTrustedRuntime(log: RuntimeLog, runtime: TrustedRuntimeProject): void {
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
  logConfigWarnings(log, runtime.settings.warnings);
}

export function logConfigWarnings(log: RuntimeLog, warnings: readonly string[]): void {
  for (const warning of warnings) {
    log.warning("config warning", { warning });
  }
}

export function addProviderSecrets(
  log: RuntimeLog,
  config: PiprConfig,
  env: NodeJS.ProcessEnv | undefined,
): void {
  for (const provider of config.providers) {
    if (provider.apiKeyEnv) {
      log.addSecret((env ?? process.env)[provider.apiKeyEnv]);
    }
  }
}
