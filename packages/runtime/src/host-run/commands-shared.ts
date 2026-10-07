import { CodeHostHttpError } from "../hosts/http.js";
import type { RunFailureCategory, RunRecorder } from "../observability/recorder-types.js";
import { ReviewProgressSupersededError } from "../review/progress.js";
import { PublicationError, StaleHeadError } from "../review/publication-result.js";
import type { createRuntimeLog, RuntimeLogSink } from "../shared/logging.js";
import type { HostRunCommandOptions } from "./types.js";

export async function finishRecorderSafely(
  recorder: RunRecorder | undefined,
  log: ReturnType<typeof createRuntimeLog> | undefined,
  result: Parameters<RunRecorder["finish"]>[0],
  onFinalized?: NonNullable<HostRunCommandOptions["onRunBundleFinalized"]>,
): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.finish(result);
    await onFinalized?.({
      executionId: recorder.executionId,
      directory: recorder.directory,
      kind: result.kind,
      outcome: result.outcome,
      ...(result.repository ? { repository: result.repository } : {}),
    });
  } catch (error) {
    log?.warning("run capture failed", {
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
}

/** Reads `PIPR_RUN_CAPTURE`; an unrecognized value is operator error and throws. */
export function parseRunCaptureSetting(
  env: NodeJS.ProcessEnv,
): "off" | "metadata" | "diagnostic" | undefined {
  const value = env.PIPR_RUN_CAPTURE;
  if (value === undefined || value === "off" || value === "metadata" || value === "diagnostic") {
    return value;
  }
  throw new Error("PIPR_RUN_CAPTURE must be off, metadata, or diagnostic");
}

export function warnRunCaptureUnavailable(
  logSink: RuntimeLogSink | undefined,
  error: unknown,
): void {
  logSink?.log({
    level: "warning",
    event: "run capture unavailable",
    fields: { error: error instanceof Error ? error.message : "unknown capture error" },
  });
}

export function classifyRunFailure(
  error: unknown,
  fallback: RunFailureCategory,
): RunFailureCategory {
  if (error instanceof ReviewProgressSupersededError || error instanceof StaleHeadError) {
    return "stale-head";
  }
  if (isAuthenticationFailure(error)) return "auth";
  if (error instanceof PublicationError) return "publication";
  const message = error instanceof Error ? error.message : String(error);
  return messageFailureCategory(message) ?? fallback;
}

function isAuthenticationFailure(error: unknown): boolean {
  if (error instanceof CodeHostHttpError) return error.status === 401 || error.status === 403;
  const cause = error instanceof PublicationError ? error.cause : undefined;
  return cause instanceof CodeHostHttpError && (cause.status === 401 || cause.status === 403);
}

function messageFailureCategory(message: string): RunFailureCategory | undefined {
  const patterns: Array<[RegExp, RunFailureCategory]> = [
    [/pi timed out|agent timed out/i, "agent-timeout"],
    [/pi output failed schema validation|invalid (?:agent|review) output/i, "invalid-output"],
    [/pi (?:exited|failed)|agent (?:exited|failed)/i, "agent-exit"],
    [/diff manifest|git diff|merge base/i, "diff"],
    [/review validation|finding validation/i, "validation"],
    [/publish|publication/i, "publication"],
  ];
  return patterns.find(([pattern]) => pattern.test(message))?.[1];
}
