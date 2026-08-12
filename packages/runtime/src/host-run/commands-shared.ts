import { CodeHostHttpError } from "../hosts/http.js";
import type { RunFailureCategory, RunRecorder } from "../observability/recorder-types.js";
import { ReviewProgressSupersededError } from "../review/progress.js";
import { PublicationError } from "../review/publication-result.js";
import type { createRuntimeLog } from "../shared/logging.js";
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

export function classifyRunFailure(
  error: unknown,
  fallback: RunFailureCategory,
): RunFailureCategory {
  if (error instanceof ReviewProgressSupersededError) return "stale-head";
  if (isAuthenticationFailure(error)) return "auth";
  const message = error instanceof Error ? error.message : String(error);
  if (/head changed|stale head/i.test(message)) return "stale-head";
  if (error instanceof PublicationError) return "publication";
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
