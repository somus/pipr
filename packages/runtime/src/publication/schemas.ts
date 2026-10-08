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

/**
 * One-letter codes for the Finding Outcome kinds kept in review state history. `proposed` and
 * `dropped` are not kept: every stored finding was proposed, and dropped findings get no record.
 */
export const findingHistoryCodes = {
  published: "p",
  carried: "c",
  outdated: "o",
  fixed: "f",
  "still-valid": "s",
  "resolved-by-human": "h",
  replied: "r",
} as const;

export type FindingHistoryCode = (typeof findingHistoryCodes)[keyof typeof findingHistoryCodes];

export const maxFindingHistoryEntries = 6;
/** Length of the head SHA prefix stored with each history entry. */
export const findingHistoryHeadLength = 12;

/** `[kindCode, head12]`: an outcome and the first 12 characters of the head it happened at. */
const findingHistoryEntrySchema = z.tuple([
  z.enum(["p", "c", "o", "f", "s", "h", "r"] satisfies FindingHistoryCode[]),
  z
    .string()
    .min(1)
    .max(findingHistoryHeadLength)
    .regex(/^[A-Za-z0-9._-]+$/),
]);

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
  /** Declared enum field values (facets) of the finding. */
  f: z
    .record(z.string().min(1).max(100), z.string().min(1).max(100))
    .refine((facets) => Object.keys(facets).length <= 32)
    .optional(),
  /** Agent that produced the finding. */
  a: z.string().min(1).max(200).optional(),
  /** Model that produced the finding. */
  m: z.string().min(1).max(200).optional(),
  /** Finding Outcome history, oldest first. */
  h: z.array(findingHistoryEntrySchema).min(1).max(maxFindingHistoryEntries).optional(),
});

export const priorReviewStateSchema = z.strictObject({
  version: z.literal(2),
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

/**
 * Index of the history entry to drop first: the oldest one other than `fixed` and
 * `resolved-by-human`, which tell later runs those outcomes were already recorded.
 */
export function oldestTrimmableHistoryIndex(history: NonNullable<PriorFindingRecord["h"]>): number {
  const index = history.findIndex(
    ([code]) =>
      code !== findingHistoryCodes.fixed && code !== findingHistoryCodes["resolved-by-human"],
  );
  return index === -1 ? 0 : index;
}

export type ReviewStats = z.infer<typeof reviewStatsSchema>;
export type ThreadAction = z.infer<typeof threadActionSchema>;
export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>;
export type PriorFindingRecord = z.infer<typeof priorFindingRecordSchema>;
export type PriorReviewState = z.infer<typeof priorReviewStateSchema>;
