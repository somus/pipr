import type { RuntimeLog } from "../shared/logging.js";
import type { SecretRedactor } from "../shared/secret-redaction.js";
import type { RunObserver } from "./types.js";

/** Where a run sends secrets to redact and captured artifacts; every sink is optional. */
export type CaptureSinks = {
  log?: Pick<RuntimeLog, "addSecret" | "warning">;
  secretRedactor?: SecretRedactor;
  runObserver?: RunObserver;
};

/** Registers a secret value with the log, the publication redactor, and the run capture. */
export function registerSecretValue(sinks: CaptureSinks, value: string): void {
  sinks.log?.addSecret(value);
  sinks.secretRedactor?.addSecret(value);
  sinks.runObserver?.registerSecret?.(value);
}

/** Records a run artifact; a capture failure is logged and never fails the run. */
export async function recordArtifactSafely(
  sinks: CaptureSinks,
  artifact: Parameters<NonNullable<RunObserver["recordArtifact"]>>[0],
): Promise<void> {
  try {
    await sinks.runObserver?.recordArtifact?.(artifact);
  } catch (error) {
    sinks.log?.warning("run capture artifact failed", {
      kind: artifact.kind,
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
}
