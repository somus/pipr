#!/usr/bin/env bun

import { runLocalReviewCommand } from "@usepipr/runtime";
import * as z from "zod";

const helperInputSchema = z.object({
  rootDir: z.string().min(1),
  baseSha: z.string().min(1),
  headSha: z.string().min(1),
  providerModule: z
    .strictObject({ path: z.string().min(1), config: z.string().min(1).optional() })
    .optional(),
});

type HelperInput = z.infer<typeof helperInputSchema>;

const input = readInput(process.argv[2]);

const result = await runLocalReviewCommand({
  rootDir: input.rootDir,
  configDir: ".pipr",
  baseSha: input.baseSha,
  headSha: input.headSha,
  ...(input.providerModule ? { piProviderModule: input.providerModule } : {}),
  env: process.env,
});

console.log(
  JSON.stringify({
    kind: result.kind,
    reviewSummary: result.review.summary.body,
    mainComment: result.mainComment,
    inlineFindings: result.inlineCommentDrafts,
    validated: {
      validFindings: result.validated.validFindings,
      droppedFindings: result.validated.droppedFindings.map(({ reason, finding }) => ({
        reason,
        body: finding.body,
        path: finding.path,
        rangeId: finding.rangeId,
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
      })),
    },
    diffRanges: result.diffManifest.files.flatMap((file) =>
      file.commentableRanges.map((range) => ({
        path: range.path,
        rangeId: range.id,
        side: range.side,
        startLine: range.startLine,
        endLine: range.endLine,
        kind: range.kind,
        preview: range.preview,
      })),
    ),
  }),
);

function readInput(value: string | undefined): HelperInput {
  if (!value) {
    throw new Error("usage: run-local-review.ts <json options>");
  }
  return helperInputSchema.parse(JSON.parse(value));
}
