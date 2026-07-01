import { z } from "zod";
import { piProviderProfileSchema } from "./pi/contract.js";
import { prReviewSchema, reviewFindingSchema } from "./review/contract.js";

export type {
  PrReview,
  ReviewFinding,
} from "./review/contract.js";

const nonEmptyStringSchema = z.string().min(1);

const providerConfigSchema = piProviderProfileSchema;

const pathGlobPatternSchema = z
  .string()
  .min(1)
  .superRefine((pattern, context) => {
    if (pattern.includes("\0")) {
      context.addIssue({ code: "custom", message: "must not contain NUL bytes" });
    }
    if (pattern.includes("\\")) {
      context.addIssue({ code: "custom", message: "must use POSIX '/' separators" });
    }
    if (pattern.startsWith("/") || /^[A-Za-z]:\//.test(pattern)) {
      context.addIssue({ code: "custom", message: "must be repo-relative" });
    }
    if (pattern.startsWith("!")) {
      context.addIssue({ code: "custom", message: "must use paths.exclude instead of negation" });
    }
    if (pattern.split("/").includes("..")) {
      context.addIssue({ code: "custom", message: "must not contain '..' segments" });
    }
  });

const pathFilterSchema = z.strictObject({
  include: z.array(pathGlobPatternSchema).min(1).optional(),
  exclude: z.array(pathGlobPatternSchema).min(1).optional(),
});

const diffManifestLimitsConfigSchema = z.strictObject({
  fullMaxBytes: z.number().int().positive().optional(),
  fullMaxEstimatedTokens: z.number().int().positive().optional(),
  condensedMaxBytes: z.number().int().positive().optional(),
  condensedMaxEstimatedTokens: z.number().int().positive().optional(),
  toolResponseMaxBytes: z.number().int().positive().optional(),
});

const autoResolveAllowedActorsSchema = z.enum(["author-or-write", "write", "any"]);

const autoResolveConfigSchema = z.strictObject({
  enabled: z.boolean(),
  model: nonEmptyStringSchema.optional(),
  instructions: z.string().min(1).max(4000).optional(),
  synchronize: z.boolean(),
  userReplies: z.strictObject({
    enabled: z.boolean(),
    respondWhenStillValid: z.boolean(),
    allowedActors: autoResolveAllowedActorsSchema,
  }),
});

const piprConfigSchema = z.strictObject({
  defaultProvider: nonEmptyStringSchema,
  providers: z.array(providerConfigSchema).min(1),
  publication: z.strictObject({
    maxInlineComments: z.number().int().min(0).max(50).optional(),
    autoResolve: autoResolveConfigSchema,
  }),
  limits: z
    .strictObject({
      timeoutSeconds: z.number().int().positive().max(3600).optional(),
      diffManifest: diffManifestLimitsConfigSchema.optional(),
    })
    .optional(),
});

const runtimeSettingsSchema = z.strictObject({
  source: nonEmptyStringSchema,
  config: piprConfigSchema,
  warnings: z.array(z.string()),
});

const platformInfoSchema = z.strictObject({
  id: nonEmptyStringSchema,
  host: nonEmptyStringSchema.optional(),
});

const repositoryRefSchema = z.strictObject({
  slug: nonEmptyStringSchema,
  url: nonEmptyStringSchema.optional(),
});

const changeEndpointSchema = z.strictObject({
  sha: nonEmptyStringSchema,
  ref: nonEmptyStringSchema.optional(),
  url: nonEmptyStringSchema.optional(),
  author: z.strictObject({ login: nonEmptyStringSchema }).optional(),
  fork: z.boolean().optional(),
});

const changeRequestRefSchema = z.strictObject({
  number: z.number().int().positive(),
  title: z.string().default(""),
  description: z.string().default(""),
  url: nonEmptyStringSchema.optional(),
  author: z.strictObject({ login: nonEmptyStringSchema }).optional(),
  base: changeEndpointSchema,
  head: changeEndpointSchema,
  isFork: z.boolean().optional(),
});

const changeRequestEventContextSchema = z.strictObject({
  eventName: nonEmptyStringSchema,
  action: nonEmptyStringSchema.optional(),
  rawAction: nonEmptyStringSchema.optional(),
  platform: platformInfoSchema,
  repository: repositoryRefSchema,
  change: changeRequestRefSchema,
  workspace: nonEmptyStringSchema,
});

const fileStatusSchema = z.enum(["added", "modified", "removed", "renamed"]);
export const reviewSideSchema = z.enum(["RIGHT", "LEFT"]);
const rangeKindSchema = z.enum(["added", "deleted", "context", "mixed"]);

export const commentableRangeSchema = z.strictObject({
  id: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  side: reviewSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  kind: rangeKindSchema,
  hunkIndex: z.number().int().positive(),
  hunkHeader: nonEmptyStringSchema,
  hunkContentHash: z.string().regex(/^[a-f0-9]{12}$/),
  summary: z.string().optional(),
  preview: z.string().optional(),
});

const diffHunkSchema = z.strictObject({
  hunkIndex: z.number().int().positive(),
  header: nonEmptyStringSchema,
  oldStart: z.number().int().min(0),
  oldLines: z.number().int().min(0),
  newStart: z.number().int().min(0),
  newLines: z.number().int().min(0),
  contentHash: z.string().regex(/^[a-f0-9]{12}$/),
});

const diffManifestFileSchema = z.strictObject({
  path: nonEmptyStringSchema,
  previousPath: nonEmptyStringSchema.optional(),
  status: fileStatusSchema,
  language: nonEmptyStringSchema.optional(),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  hunks: z.array(diffHunkSchema),
  commentableRanges: z.array(commentableRangeSchema),
  signals: z.array(z.string()).optional(),
  changedSymbols: z.array(z.string()).optional(),
  excludedReason: nonEmptyStringSchema.optional(),
});

const diffManifestSchema = z.strictObject({
  baseSha: nonEmptyStringSchema,
  headSha: nonEmptyStringSchema,
  mergeBaseSha: nonEmptyStringSchema,
  files: z.array(diffManifestFileSchema),
});

const diffManifestPromptMetricsSchema = z.strictObject({
  bytes: z.number().int().min(0),
  estimatedTokens: z.number().int().min(0),
});

const droppedFindingSchema = z.strictObject({
  finding: reviewFindingSchema,
  reason: nonEmptyStringSchema,
});

const validatedReviewSchema = z.strictObject({
  review: prReviewSchema,
  validFindings: z.array(reviewFindingSchema),
  droppedFindings: z.array(droppedFindingSchema),
});

const commandPermissionLevelSchema = z.enum(["read", "triage", "write", "maintain", "admin"]);

export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type PathFilter = z.infer<typeof pathFilterSchema>;
export type DiffManifestLimitsConfig = z.infer<typeof diffManifestLimitsConfigSchema>;
export type AutoResolveConfig = z.infer<typeof autoResolveConfigSchema>;
export type PiprConfig = z.infer<typeof piprConfigSchema>;
export type RuntimeSettings = z.infer<typeof runtimeSettingsSchema>;
export type PlatformInfo = z.infer<typeof platformInfoSchema>;
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;
export type ChangeRequestRef = z.infer<typeof changeRequestRefSchema>;
export type ChangeRequestEventContext = z.infer<typeof changeRequestEventContextSchema>;
export type FileStatus = z.infer<typeof fileStatusSchema>;
export type ReviewSide = z.infer<typeof reviewSideSchema>;
export type RangeKind = z.infer<typeof rangeKindSchema>;
export type CommentableRange = z.infer<typeof commentableRangeSchema>;
export type DiffHunk = z.infer<typeof diffHunkSchema>;
export type DiffManifestFile = z.infer<typeof diffManifestFileSchema>;
export type DiffManifest = z.infer<typeof diffManifestSchema>;
export type DiffManifestPromptMetrics = z.infer<typeof diffManifestPromptMetricsSchema>;
export type ValidatedReview = z.infer<typeof validatedReviewSchema>;
export type CommandPermissionLevel = z.infer<typeof commandPermissionLevelSchema>;

export function parseProviderConfig(value: unknown): ProviderConfig {
  return providerConfigSchema.parse(value);
}

export function parsePiprConfig(value: unknown): PiprConfig {
  return piprConfigSchema.parse(value);
}

export function parseRuntimeSettings(value: unknown): RuntimeSettings {
  return runtimeSettingsSchema.parse(value);
}

export function parseChangeRequestEventContext(value: unknown): ChangeRequestEventContext {
  return changeRequestEventContextSchema.parse(value);
}

export function parseDiffManifest(value: unknown): DiffManifest {
  return diffManifestSchema.parse(value);
}

export function parseValidatedReview(value: unknown): ValidatedReview {
  return validatedReviewSchema.parse(value);
}
