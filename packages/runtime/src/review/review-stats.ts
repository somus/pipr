import {
  maxReviewStatsModelsLimit,
  reviewStatsSchema,
  sanitizeReviewStatsModel,
} from "../publication/schemas.js";
import type { ReviewStats } from "../publication/types.js";

export { reviewStatsSchema, sanitizeReviewStatsModel };
export const maxReviewStatsModels = maxReviewStatsModelsLimit;

export function accumulateReviewStats(
  prior: ReviewStats | undefined,
  current: ReviewStats | undefined,
): ReviewStats | undefined {
  if (!prior) {
    return current;
  }
  if (!current) {
    const retained = { ...prior };
    delete retained.diffContextCoverage;
    return retained;
  }
  const inputTokens = addUsageTotal(prior.inputTokens, current.inputTokens, Number.isSafeInteger);
  const outputTokens = addUsageTotal(
    prior.outputTokens,
    current.outputTokens,
    Number.isSafeInteger,
  );
  const costUsd = addUsageTotal(prior.costUsd, current.costUsd, Number.isFinite);
  const usageComplete = inputTokens.complete && outputTokens.complete && costUsd.complete;
  const usageStatus =
    usageComplete && prior.usageStatus === current.usageStatus ? prior.usageStatus : "partial";
  const cacheReadTokens = addUsageTotal(
    prior.cacheReadTokens ?? 0,
    current.cacheReadTokens ?? 0,
    Number.isSafeInteger,
  );
  const cacheWriteTokens = addUsageTotal(
    prior.cacheWriteTokens ?? 0,
    current.cacheWriteTokens ?? 0,
    Number.isSafeInteger,
  );
  const cacheUsageComplete = cacheReadTokens.complete && cacheWriteTokens.complete;
  const priorCacheStatus = prior.cacheUsageStatus ?? "unavailable";
  const currentCacheStatus = current.cacheUsageStatus ?? "unavailable";
  const cacheUsageStatus =
    cacheUsageComplete && priorCacheStatus === currentCacheStatus ? priorCacheStatus : "partial";

  return {
    models: [...new Set([...prior.models, ...current.models])].slice(0, maxReviewStatsModels),
    agentRuns: Math.min(Number.MAX_SAFE_INTEGER, prior.agentRuns + current.agentRuns),
    durationMs: Math.min(Number.MAX_SAFE_INTEGER, prior.durationMs + current.durationMs),
    inputTokens: inputTokens.total,
    outputTokens: outputTokens.total,
    costUsd: costUsd.total,
    usageStatus,
    cacheReadTokens: cacheReadTokens.total,
    cacheWriteTokens: cacheWriteTokens.total,
    cacheUsageStatus,
    ...(current.diffContextCoverage ? { diffContextCoverage: current.diffContextCoverage } : {}),
  };
}

function addUsageTotal(
  prior: number,
  current: number,
  isValid: (value: number) => boolean,
): { total: number; complete: boolean } {
  const total = prior + current;
  return isValid(total) && total >= 0
    ? { total, complete: true }
    : { total: prior, complete: false };
}
