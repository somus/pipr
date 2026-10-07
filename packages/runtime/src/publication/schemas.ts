/**
 * Leaf Zod schemas for publication contract types. Types are derived via
 * `z.infer` so runtime validation and compile-time shapes stay aligned.
 * This module may import from shared/ and external packages only.
 */
import { z } from "zod";

const reviewSideSchema = z.enum(["RIGHT", "LEFT"]);

export const findingIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/);

export const maxReviewStatsModels = 20;
const maxReviewStatsModelLength = 200;

export function sanitizeReviewStatsModel(model: string): string | undefined {
  const normalized = model.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, maxReviewStatsModelLength) : undefined;
}

const reviewStatsModelSchema = z
  .string()
  .min(1)
  .max(maxReviewStatsModelLength)
  .transform((model) => sanitizeReviewStatsModel(model) ?? "[invalid model]");

const coverageCountsSchema = z
  .strictObject({
    total: z.number().int().nonnegative(),
    covered: z.number().int().nonnegative(),
  })
  .refine((coverage) => coverage.covered <= coverage.total, {
    message: "covered context cannot exceed total context",
  });

const diffContextCoverageSchema = z.strictObject({
  files: coverageCountsSchema,
  ranges: coverageCountsSchema,
});

const reviewStatsSchema = z.strictObject({
  models: z.array(reviewStatsModelSchema).min(1).max(maxReviewStatsModels),
  agentRuns: z.number().int().positive(),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  usageStatus: z.enum(["complete", "partial", "unavailable"]),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  cacheUsageStatus: z.enum(["complete", "partial", "unavailable"]).optional(),
  diffContextCoverage: diffContextCoverageSchema.optional(),
});

const priorFindingStatusSchema = z.enum(["open", "resolved"]);

const workflowUrlSchema = z
  .string()
  .url()
  .max(2_048)
  .refine((candidate) => {
    const url = new URL(candidate);
    return (
      (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
    );
  });

const priorFindingRecordSchema = z.strictObject({
  id: findingIdSchema,
  anchorFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  issueFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: priorFindingStatusSchema,
  path: z.string().min(1),
  rangeId: z.string().min(1),
  side: reviewSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  firstSeenHeadSha: z.string().min(1),
  lastSeenHeadSha: z.string().min(1),
  lastCommentedHeadSha: z.string().min(1).optional(),
});

export const priorReviewStateSchema = z.strictObject({
  version: z.literal(1),
  reviewedHeadSha: z.string().min(1),
  selectedTasks: z.array(z.string().min(1)),
  findings: z.array(priorFindingRecordSchema),
  stats: reviewStatsSchema.optional(),
  workflowUrls: z.array(workflowUrlSchema).optional(),
});

export const threadActionSchema = z.strictObject({
  kind: z.enum(["resolve", "reply"]),
  findingId: findingIdSchema,
  findingHeadSha: z.string().min(1),
  commentId: z.string().min(1),
  threadId: z.string().min(1).optional(),
  body: z.string().min(1),
  responseKey: z.string().min(1),
});

export const publicationMetadataSchema = z.strictObject({
  runtimeVersion: z.string().min(1),
  configVersion: z.string().min(1).optional(),
  trustedConfigSha: z.string().min(1).optional(),
  trustedConfigHash: z.string().min(1).optional(),
  reviewedHeadSha: z.string().min(1),
  providerModels: z.array(z.string().min(1)).optional(),
  selectedTasks: z.array(z.string().min(1)),
  failedTasks: z.array(z.string().min(1)),
  validFindings: z.number().int().min(0),
  droppedFindings: z.number().int().min(0),
  cappedInlineFindings: z.number().int().min(0),
  stats: reviewStatsSchema.optional(),
  workflowUrl: workflowUrlSchema.optional(),
});

export type ReviewStats = z.infer<typeof reviewStatsSchema>;
export type ThreadAction = z.infer<typeof threadActionSchema>;
export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>;
export type PriorFindingRecord = z.infer<typeof priorFindingRecordSchema>;
export type PriorReviewState = z.infer<typeof priorReviewStateSchema>;
