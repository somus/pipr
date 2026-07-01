import { z } from "zod";
import runtimePackage from "../../package.json" with { type: "json" };
import { createDiffRangeIndex } from "../diff/ranges.js";
import type { ChangeRequestEventContext, DiffManifest, ReviewFinding } from "../types.js";
import { commentableRangeSchema, reviewSideSchema } from "../types.js";
import { reviewFindingSchema } from "./contract.js";
import {
  buildPriorReviewState,
  findingIdFor,
  findingIdSchema,
  inlineFindingMarker,
  mainCommentMarker,
  matchFindingRecord,
  type PriorReviewState,
  priorReviewStateSchema,
  renderInlineFindingMarker,
  renderMainCommentMarker,
} from "./prior-state.js";

export const runtimeVersion = runtimePackage.version;

const inlinePublicationItemSchema = z
  .strictObject({
    finding: reviewFindingSchema,
    range: commentableRangeSchema,
    path: z.string().min(1),
    side: reviewSideSchema,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    body: z.string().min(1),
    marker: z.string().min(1),
    findingId: findingIdSchema,
    reviewedHeadSha: z.string().min(1),
  })
  .superRefine((item, context) => {
    if (item.path !== item.finding.path) {
      context.addIssue({ code: "custom", path: ["path"], message: "path must match finding.path" });
    }
    if (item.side !== item.finding.side) {
      context.addIssue({ code: "custom", path: ["side"], message: "side must match finding.side" });
    }
    if (item.startLine !== item.finding.startLine) {
      context.addIssue({
        code: "custom",
        path: ["startLine"],
        message: "startLine must match finding.startLine",
      });
    }
    if (item.endLine !== item.finding.endLine) {
      context.addIssue({
        code: "custom",
        path: ["endLine"],
        message: "endLine must match finding.endLine",
      });
    }
  });

const inlinePublicationItemsSchema = z.array(inlinePublicationItemSchema);

export type InlinePublicationItem = z.infer<typeof inlinePublicationItemSchema>;
export type InlineCommentDraft = InlinePublicationItem;

const threadActionSchema = z.strictObject({
  kind: z.enum(["resolve", "reply"]),
  findingId: findingIdSchema,
  findingHeadSha: z.string().min(1),
  commentId: z.number().int().positive(),
  threadId: z.string().min(1).optional(),
  body: z.string().min(1),
  responseKey: z.string().min(1),
});

const threadActionsSchema = z.array(threadActionSchema);

export type ThreadAction = z.infer<typeof threadActionSchema>;

const publicationMetadataSchema = z.strictObject({
  runtimeVersion: z.string().min(1),
  trustedConfigSha: z.string().min(1).optional(),
  trustedConfigHash: z.string().min(1).optional(),
  reviewedHeadSha: z.string().min(1),
  providerModels: z.array(z.string().min(1)).optional(),
  selectedTasks: z.array(z.string().min(1)),
  failedTasks: z.array(z.string().min(1)),
  validFindings: z.number().int().min(0),
  droppedFindings: z.number().int().min(0),
  cappedInlineFindings: z.number().int().min(0),
});

export type PublicationMetadata = z.infer<typeof publicationMetadataSchema>;

const publicationPlanSchema = z.strictObject({
  mainComment: z.string().min(1),
  mainMarker: z.string().min(1),
  changeNumber: z.number().int().positive(),
  inlineItems: inlinePublicationItemsSchema,
  metadata: publicationMetadataSchema,
  reviewState: priorReviewStateSchema,
  threadActions: threadActionsSchema,
});

export type PublicationPlan = z.infer<typeof publicationPlanSchema>;

export type BuildPublicationPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  main: string;
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  reviewState?: PriorReviewState;
  threadActions?: ThreadAction[];
};

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
  const reviewState =
    options.reviewState ??
    buildPriorReviewState({
      findings: options.inlineItems.map((item) => item.finding),
      reviewedHeadSha: options.metadata.reviewedHeadSha,
      selectedTasks: options.metadata.selectedTasks,
    }).state;
  const cappedInlineItems =
    options.maxInlineComments === undefined
      ? options.inlineItems
      : options.inlineItems.slice(0, options.maxInlineComments);
  const metadata = publicationMetadataSchema.parse({
    ...options.metadata,
    cappedInlineFindings: options.inlineItems.length - cappedInlineItems.length,
  });
  return publicationPlanSchema.parse({
    mainComment: renderMainComment({
      event: options.event,
      reviewState,
      main: options.main,
    }),
    mainMarker: mainCommentMarker,
    changeNumber: options.event.change.number,
    inlineItems: cappedInlineItems,
    metadata,
    reviewState,
    threadActions: options.threadActions ?? [],
  });
}

export function prepareInlinePublicationItems(options: {
  validated: {
    validFindings: ReviewFinding[];
  };
  manifest: DiffManifest;
  reviewedHeadSha: string;
  reviewState?: PriorReviewState;
}): InlinePublicationItem[] {
  const ranges = createDiffRangeIndex(options.manifest);
  const seenFindingIds = new Set<string>();
  return inlinePublicationItemsSchema.parse(
    options.validated.validFindings.flatMap((finding) => {
      const range = ranges.rangeById(finding.rangeId);
      if (!range) {
        throw new Error(
          `Validated finding range '${finding.rangeId}' is missing from Diff Manifest`,
        );
      }
      const findingId = findingIdFor(finding, options.reviewState);
      const stateRecord = options.reviewState
        ? matchFindingRecord(options.reviewState, finding)
        : undefined;
      if (
        seenFindingIds.has(findingId) ||
        stateRecord?.lastCommentedHeadSha === options.reviewedHeadSha
      ) {
        return [];
      }
      seenFindingIds.add(findingId);
      const marker = inlineFindingMarker(findingId, options.reviewedHeadSha);
      return [
        inlinePublicationItemSchema.parse({
          finding,
          range,
          path: finding.path,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          marker,
          findingId,
          reviewedHeadSha: options.reviewedHeadSha,
          body: renderInlineBody(finding, findingId, options.reviewedHeadSha),
        }),
      ];
    }),
  );
}

function renderMainComment(options: {
  event: Pick<ChangeRequestEventContext, "change">;
  reviewState: PriorReviewState;
  main: string;
}): string {
  return [
    renderMainCommentMarker({
      marker: mainCommentMarker,
      changeNumber: options.event.change.number,
      reviewState: options.reviewState,
    }),
    "",
    "# pipr Review",
    "",
    options.main,
    "",
  ].join("\n");
}

function renderInlineBody(
  finding: ReviewFinding,
  findingId: string,
  reviewedHeadSha: string,
): string {
  return [
    renderInlineFindingMarker(findingId, reviewedHeadSha),
    finding.body,
    finding.suggestedFix ? `\n${renderSuggestedChange(finding.suggestedFix)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function renderSuggestedChange(suggestedFix: string): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(suggestedFix) + 1));
  const closingPrefix = suggestedFix.endsWith("\n") ? "" : "\n";
  return `${fence}suggestion\n${suggestedFix}${closingPrefix}${fence}`;
}

function longestBacktickRun(value: string): number {
  return Math.max(0, ...[...value.matchAll(/`+/g)].map((match) => match[0].length));
}
