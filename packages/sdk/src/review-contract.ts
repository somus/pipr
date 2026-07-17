import { z } from "zod";
import type { ZodSchema } from "./types/schema.js";

/** Markdown summary produced by a reviewer for the main review comment. */
export type ReviewSummary = {
  title?: string;
  body: string;
};

/** One inline review finding targeting a Diff Manifest commentable range. */
export type ReviewFinding = {
  issueKey?: string;
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
};

/** Core structured review result accepted by pipr review publication. */
export type ReviewResult = {
  summary: ReviewSummary;
  inlineFindings: ReviewFinding[];
};

const nonEmptyStringSchema = z.string().min(1);
const positiveIntegerSchema = z.number().int().positive();
export const issueKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/);

/** Zod schema for a review summary. */
export const reviewSummarySchema: ZodSchema<ReviewSummary> = z.strictObject({
  title: nonEmptyStringSchema.optional(),
  body: nonEmptyStringSchema,
});

/** Zod schema for one inline review finding. */
export const reviewFindingSchema: ZodSchema<ReviewFinding> = z.strictObject({
  issueKey: issueKeySchema.optional(),
  body: nonEmptyStringSchema,
  path: nonEmptyStringSchema,
  rangeId: nonEmptyStringSchema,
  side: z.enum(["RIGHT", "LEFT"]),
  startLine: positiveIntegerSchema,
  endLine: positiveIntegerSchema,
  suggestedFix: nonEmptyStringSchema.optional(),
});

/** Zod schema for Pipr's core change request review result. */
export const reviewResultSchema: ZodSchema<ReviewResult> = z.strictObject({
  summary: reviewSummarySchema,
  inlineFindings: z.array(reviewFindingSchema),
});

/** Parses model output for Pipr's main change request review schema. */
export function parseReviewResult(value: unknown): ReviewResult {
  return reviewResultSchema.parse(value) as ReviewResult;
}

/** Parses a review summary value. */
export function parseReviewSummary(value: unknown): ReviewSummary {
  return reviewSummarySchema.parse(value);
}

/** Parses one inline review finding. */
export function parseReviewFinding(value: unknown): ReviewFinding {
  return reviewFindingSchema.parse(value) as ReviewFinding;
}

/** Returns a small valid example for the main change request review schema. */
export function reviewSchemaExample(): ReviewResult {
  return {
    summary: {
      title: "Optional concise review title.",
      body: "Concise change request review summary.",
    },
    inlineFindings: [
      {
        issueKey: "example-unsafe-return",
        body: "Specific issue and why it matters.",
        path: "src/example.ts",
        rangeId: "rng_example",
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        suggestedFix: "return safeValue;",
      },
    ],
  };
}
