import { z } from "zod";

export const maxReviewStatsModels = 20;
const maxReviewStatsModelLength = 200;
const reviewStatsModelSchema = z
  .string()
  .min(1)
  .max(maxReviewStatsModelLength)
  .transform((model) => sanitizeReviewStatsModel(model) ?? "[invalid model]");

export const reviewStatsSchema = z.strictObject({
  models: z.array(reviewStatsModelSchema).min(1).max(maxReviewStatsModels),
  agentRuns: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  usageStatus: z.enum(["complete", "partial", "unavailable"]),
});

export type ReviewStats = z.infer<typeof reviewStatsSchema>;

export function accumulateReviewStats(
  prior: ReviewStats | undefined,
  current: ReviewStats | undefined,
): ReviewStats | undefined {
  if (!prior) {
    return current;
  }
  if (!current) {
    return prior;
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

  return {
    models: [...new Set([...prior.models, ...current.models])].slice(0, maxReviewStatsModels),
    agentRuns: Math.min(Number.MAX_SAFE_INTEGER, prior.agentRuns + current.agentRuns),
    durationMs: Math.min(Number.MAX_SAFE_INTEGER, prior.durationMs + current.durationMs),
    inputTokens: inputTokens.total,
    outputTokens: outputTokens.total,
    costUsd: costUsd.total,
    usageStatus,
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

export function sanitizeReviewStatsModel(model: string): string | undefined {
  const normalized = model.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxReviewStatsModelLength) : undefined;
}
