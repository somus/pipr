import { z } from "zod";
import { piprResultLimits } from "./result-limits.js";
import { type ReviewFinding, reviewFindingSchema } from "./review-contract.js";

export type PiprRunSummary = {
  id: string;
  trigger: "change-request" | "command" | "verifier" | "local";
  baseSha: string;
  headSha: string;
  tasks: string[];
  durationMs: number;
  models: string[];
  agentRuns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  usageStatus: "complete" | "partial" | "unavailable";
};

type InlineCommentCounts = {
  posted: number;
  skipped: number;
  failed: number;
};

type CompletedReviewPublication = {
  state: "completed";
  mainComment: { action: "created" | "updated" };
  inlineComments: InlineCommentCounts;
  inlinePublicationErrorCount: number;
  inlineResolutionErrorCount: number;
};

export type PiprResult =
  | {
      formatVersion: 2;
      kind: "review";
      run: PiprRunSummary;
      mainComment: string;
      inlineFindings: ReviewFinding[];
      droppedFindings: Array<{ finding: ReviewFinding; reason: string }>;
      taskChecks: Array<{
        taskName: string;
        conclusion: "success" | "failure" | "neutral";
        summary?: string;
      }>;
      repairAttempted: boolean;
      publication: { state: "disabled" } | CompletedReviewPublication;
    }
  | { formatVersion: 2; kind: "skipped"; reason: string }
  | { formatVersion: 2; kind: "ignored"; reason: string }
  | { formatVersion: 2; kind: "dry-run" }
  | { formatVersion: 2; kind: "command-help"; reason: string; mainComment: string }
  | {
      formatVersion: 2;
      kind: "command-response";
      run: PiprRunSummary;
      mainComment: string;
      publication: { state: "completed"; action: "created" | "updated" };
    }
  | {
      formatVersion: 2;
      kind: "verifier";
      run: PiprRunSummary;
      publication: { state: "completed"; inlineResolutionErrorCount: number };
    }
  | {
      formatVersion: 2;
      kind: "publication-error";
      message: string;
      publication?: {
        inlineComments: InlineCommentCounts;
        inlinePublicationErrorCount: number;
        inlineResolutionErrorCount: number;
      };
    }
  | { formatVersion: 2; kind: "error"; message: string };

const nonEmptyStringSchema = z.string().min(1);
const nonnegativeIntegerSchema = z.number().int().nonnegative();
const resultHeaderSchema = {
  formatVersion: z.literal(2),
};

const piprRunSummarySchema = z.strictObject({
  id: nonEmptyStringSchema.max(piprResultLimits.runTextLength),
  trigger: z.enum(["change-request", "command", "verifier", "local"]),
  baseSha: nonEmptyStringSchema.max(piprResultLimits.runTextLength),
  headSha: nonEmptyStringSchema.max(piprResultLimits.runTextLength),
  tasks: z
    .array(nonEmptyStringSchema.max(piprResultLimits.runTextLength))
    .max(piprResultLimits.runTasks),
  durationMs: nonnegativeIntegerSchema,
  models: z
    .array(nonEmptyStringSchema.max(piprResultLimits.runTextLength))
    .max(piprResultLimits.runModels),
  agentRuns: nonnegativeIntegerSchema,
  inputTokens: nonnegativeIntegerSchema,
  outputTokens: nonnegativeIntegerSchema,
  costUsd: z.number().nonnegative().finite(),
  usageStatus: z.enum(["complete", "partial", "unavailable"]),
});

const droppedFindingSchema = z.strictObject({
  finding: reviewFindingSchema,
  reason: nonEmptyStringSchema,
});

const taskCheckSchema = z.strictObject({
  taskName: nonEmptyStringSchema,
  conclusion: z.enum(["success", "failure", "neutral"]),
  summary: nonEmptyStringSchema.optional(),
});

const inlineCommentCountsSchema = z.strictObject({
  posted: nonnegativeIntegerSchema,
  skipped: nonnegativeIntegerSchema,
  failed: nonnegativeIntegerSchema,
});

const reviewPublicationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("disabled") }),
  z.strictObject({
    state: z.literal("completed"),
    mainComment: z.strictObject({ action: z.enum(["created", "updated"]) }),
    inlineComments: inlineCommentCountsSchema,
    inlinePublicationErrorCount: nonnegativeIntegerSchema,
    inlineResolutionErrorCount: nonnegativeIntegerSchema,
  }),
]);

const reviewResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("review"),
  run: piprRunSummarySchema,
  mainComment: z.string(),
  inlineFindings: z.array(reviewFindingSchema),
  droppedFindings: z.array(droppedFindingSchema),
  taskChecks: z.array(taskCheckSchema),
  repairAttempted: z.boolean(),
  publication: reviewPublicationSchema,
});

const skippedResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("skipped"),
  reason: nonEmptyStringSchema,
});

const ignoredResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("ignored"),
  reason: nonEmptyStringSchema,
});

const dryRunResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("dry-run"),
});

const commandHelpResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("command-help"),
  reason: nonEmptyStringSchema,
  mainComment: z.string(),
});

const commandResponseResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("command-response"),
  run: piprRunSummarySchema,
  mainComment: z.string(),
  publication: z.strictObject({
    state: z.literal("completed"),
    action: z.enum(["created", "updated"]),
  }),
});

const verifierResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("verifier"),
  run: piprRunSummarySchema,
  publication: z.strictObject({
    state: z.literal("completed"),
    inlineResolutionErrorCount: nonnegativeIntegerSchema,
  }),
});

const publicationErrorResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("publication-error"),
  message: nonEmptyStringSchema,
  publication: z
    .strictObject({
      inlineComments: inlineCommentCountsSchema,
      inlinePublicationErrorCount: nonnegativeIntegerSchema,
      inlineResolutionErrorCount: nonnegativeIntegerSchema,
    })
    .optional(),
});

const errorResultSchema = z.strictObject({
  ...resultHeaderSchema,
  kind: z.literal("error"),
  message: nonEmptyStringSchema,
});

export const piprResultSchema: z.ZodType<PiprResult> = z.discriminatedUnion("kind", [
  reviewResultSchema,
  skippedResultSchema,
  ignoredResultSchema,
  dryRunResultSchema,
  commandHelpResultSchema,
  commandResponseResultSchema,
  verifierResultSchema,
  publicationErrorResultSchema,
  errorResultSchema,
]);

export function parsePiprResult(value: unknown): PiprResult {
  return piprResultSchema.parse(value);
}
