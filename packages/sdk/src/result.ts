import { z } from "zod";
import { type ReviewFinding, reviewFindingSchema } from "./review-contract.js";

const piprRunTriggers = ["change-request", "command", "verifier", "local"] as const;

export type PiprRunTrigger = (typeof piprRunTriggers)[number];

export type PiprRunContext = {
  readonly id: string;
  readonly trigger: PiprRunTrigger;
};

export type PiprRunSummary = PiprRunContext & {
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

type InlineCommentCounts = { posted: number; skipped: number; failed: number };
type ReviewPublication =
  | { state: "disabled" }
  | {
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
      publication: ReviewPublication;
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

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const header = { formatVersion: z.literal(2) };
const runSummarySchema = z.strictObject({
  id: text.max(200),
  trigger: z.enum(piprRunTriggers),
  baseSha: text.max(200),
  headSha: text.max(200),
  tasks: z.array(text.max(200)).max(200),
  durationMs: count,
  models: z.array(text.max(200)).max(20),
  agentRuns: count,
  inputTokens: count,
  outputTokens: count,
  costUsd: z.number().nonnegative().finite(),
  usageStatus: z.enum(["complete", "partial", "unavailable"]),
});
const inlineCountsSchema = z.strictObject({ posted: count, skipped: count, failed: count });
const publicationCountsSchema = z.strictObject({
  inlineComments: inlineCountsSchema,
  inlinePublicationErrorCount: count,
  inlineResolutionErrorCount: count,
});
const reviewPublicationSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("disabled") }),
  z.strictObject({
    state: z.literal("completed"),
    mainComment: z.strictObject({ action: z.enum(["created", "updated"]) }),
    ...publicationCountsSchema.shape,
  }),
]);
const schemas = [
  z.strictObject({
    ...header,
    kind: z.literal("review"),
    run: runSummarySchema,
    mainComment: z.string(),
    inlineFindings: z.array(reviewFindingSchema),
    droppedFindings: z.array(z.strictObject({ finding: reviewFindingSchema, reason: text })),
    taskChecks: z.array(
      z.strictObject({
        taskName: text,
        conclusion: z.enum(["success", "failure", "neutral"]),
        summary: text.optional(),
      }),
    ),
    repairAttempted: z.boolean(),
    publication: reviewPublicationSchema,
  }),
  z.strictObject({ ...header, kind: z.literal("skipped"), reason: text }),
  z.strictObject({ ...header, kind: z.literal("ignored"), reason: text }),
  z.strictObject({ ...header, kind: z.literal("dry-run") }),
  z.strictObject({
    ...header,
    kind: z.literal("command-help"),
    reason: text,
    mainComment: z.string(),
  }),
  z.strictObject({
    ...header,
    kind: z.literal("command-response"),
    run: runSummarySchema,
    mainComment: z.string(),
    publication: z.strictObject({
      state: z.literal("completed"),
      action: z.enum(["created", "updated"]),
    }),
  }),
  z.strictObject({
    ...header,
    kind: z.literal("verifier"),
    run: runSummarySchema,
    publication: z.strictObject({
      state: z.literal("completed"),
      inlineResolutionErrorCount: count,
    }),
  }),
  z.strictObject({
    ...header,
    kind: z.literal("publication-error"),
    message: text,
    publication: publicationCountsSchema.optional(),
  }),
  z.strictObject({ ...header, kind: z.literal("error"), message: text }),
] as const;

export const piprResultSchema: z.ZodType<PiprResult> = z.discriminatedUnion("kind", schemas);

export function parsePiprResult(value: unknown): PiprResult {
  return piprResultSchema.parse(value);
}
