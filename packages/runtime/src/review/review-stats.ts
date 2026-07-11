import { z } from "zod";
import { redactPotentialSecrets } from "../shared/redaction.js";

export const maxReviewStatsModels = 20;
const maxReviewStatsModelLength = 200;
const credentialLikeModelPattern =
  /(?:(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_live_[A-Za-z0-9]{16,}|sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,})/i;
const highEntropyModelSegmentPattern = /[A-Za-z0-9]{24,}/;
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

export function sanitizeReviewStatsModel(model: string): string | undefined {
  const normalized = model.replace(/\s+/g, " ").trim();
  if (
    credentialLikeModelPattern.test(normalized) ||
    highEntropyModelSegmentPattern.test(normalized)
  ) {
    return "[redacted credential]";
  }
  const sanitized = redactPotentialSecrets(normalized);
  return sanitized ? sanitized.slice(0, maxReviewStatsModelLength) : undefined;
}
