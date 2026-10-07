import { ProviderExecutionError } from "../../pi/provider-failure.js";
import type { PiRunResult } from "../../pi/types.js";

/** A successful model call result for injected test runners. */
export function piRunResult(text: string, patch: Partial<PiRunResult> = {}): PiRunResult {
  return {
    text,
    conversationId: 1,
    durationMs: 1,
    models: [],
    usage: { status: "complete", inputTokens: 0, outputTokens: 0, costUsd: 0 },
    ...patch,
  };
}

/** The error an injected test runner throws for a failed model call. */
export function piRunFailure(detail: string): ProviderExecutionError {
  return new ProviderExecutionError("Pi agent failed (model_error)", undefined, detail);
}
