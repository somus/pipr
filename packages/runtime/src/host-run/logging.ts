import type { LoadedRuntimeProject } from "../config/project.js";
import type { RuntimeLog } from "../shared/logging.js";
import { runLoggedPhase, shortSha } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import type { TrustedRuntimeProject } from "./types.js";

export async function logPhase<T>(
  log: RuntimeLog,
  name: string,
  run: () => Promise<T> | T,
): Promise<T> {
  return await runLoggedPhase(log, name, run, { includeDebugStack: true });
}

/** Logs why an event was ignored and returns the ignored result. */
export function ignore(log: RuntimeLog, reason: string): { kind: "ignored"; reason: string } {
  log.notice("event ignored", { reason });
  return { kind: "ignored", reason };
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

/** Provider, task, and command counts logged when a config loads. */
export function runtimeSummaryFields(runtime: Pick<LoadedRuntimeProject, "plan" | "settings">) {
  return {
    providers: runtime.settings.config.providers
      .map((provider) => `${provider.id}:${provider.model}`)
      .join(","),
    tasks: runtime.plan.tasks.length,
    commands: runtime.plan.commands.length,
  };
}

export function logTrustedRuntime(log: RuntimeLog, runtime: TrustedRuntimeProject): void {
  log.notice("trusted config", {
    source: runtime.settings.source,
    trustedConfigSha: shortSha(runtime.trustedConfigSha),
    trustedConfigHash: runtime.trustedConfigHash.slice(0, 12),
    ...runtimeSummaryFields(runtime),
  });
  logConfigWarnings(log, runtime.settings.warnings);
}

export function logConfigWarnings(log: RuntimeLog, warnings: readonly string[]): void {
  for (const warning of warnings) {
    log.warning("config warning", { warning });
  }
}
