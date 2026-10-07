import { z } from "zod";
import { createDiffRangeIndex } from "../diff/ranges.js";
import {
  findingIdSchema,
  priorReviewStateSchema,
  publicationMetadataSchema,
  threadActionSchema,
} from "../publication/schemas.js";
import type {
  InlinePublicationItem,
  PriorReviewState,
  PublicationMetadata,
  PublicationPlan,
  ThreadAction,
} from "../publication/types.js";
import type {
  ChangeRequestEventContext,
  CommentableRange,
  DiffManifest,
  ReviewFinding,
  ValidatedReview,
} from "../types.js";
import { commentableRangeSchema, reviewSideSchema } from "../types.js";
import { renderInlineBody, renderMainComment, renderSuggestedChange } from "./comment.js";
import { inlineFindingMarker, mainCommentMarker } from "./comment-markers.js";
import { reviewFindingSchema } from "./contract.js";
import {
  buildPriorReviewState,
  countFindingFingerprints,
  findingIdFor,
  matchFindingRecord,
  matchResolvedFindingRecord,
} from "./prior-state.js";
import { isPublishableSuggestedFixSelection } from "./suggested-fix-publication-policy.js";

const inlinePublicationItemSchema = z
  .strictObject({
    finding: reviewFindingSchema,
    range: commentableRangeSchema,
    path: z.string().min(1),
    previousPath: z.string().min(1).optional(),
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

export type InlineCommentDraft = InlinePublicationItem;
type PublishableInlineFinding = {
  finding: ReviewFinding;
  range: CommentableRange;
  previousPath?: string;
  anchorFingerprint?: string;
  issueFingerprint?: string;
};

/** Validated plan inputs; the rendered main comment and marker are added after parsing. */
const publicationPlanInputSchema = z.strictObject({
  changeNumber: z.number().int().positive(),
  inlineItems: z.array(inlinePublicationItemSchema),
  metadata: publicationMetadataSchema,
  reviewState: priorReviewStateSchema,
  threadActions: z.array(threadActionSchema),
});

export function publicationPlanForHostCapabilities(
  plan: PublicationPlan,
  capabilities: { multilineInlineComments: boolean; suggestedChanges: boolean },
): PublicationPlan {
  return {
    ...plan,
    inlineItems: plan.inlineItems
      .filter((item) => capabilities.multilineInlineComments || item.startLine === item.endLine)
      .map((item) => {
        if (capabilities.suggestedChanges || !item.finding.suggestedFix) {
          return item;
        }
        const finding = withoutSuggestedFix(item.finding);
        return {
          ...item,
          finding,
          body: [
            renderInlineBody(finding, item.findingId, item.reviewedHeadSha),
            "**Suggested change**",
            "",
            renderSuggestedChange(item.finding.suggestedFix, false),
          ].join("\n"),
        };
      }),
  };
}

export type BuildPublicationPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  main: string;
  inlineItems: InlinePublicationItem[];
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  maxStoredFindings?: number;
  showHeader?: boolean;
  showFooter?: boolean;
  showStats?: boolean;
  reviewState?: PriorReviewState;
  threadActions?: ThreadAction[];
};

export function buildPublicationPlan(options: BuildPublicationPlanOptions): PublicationPlan {
  const reviewState =
    options.reviewState ??
    buildPriorReviewState({
      findings: options.inlineItems.map((item) => ({ finding: item.finding })),
      reviewedHeadSha: options.metadata.reviewedHeadSha,
      selectedTasks: options.metadata.selectedTasks,
    });
  const publishedCount =
    options.maxInlineComments === undefined
      ? options.inlineItems.length
      : options.inlineItems.slice(0, options.maxInlineComments).length;
  const input = publicationPlanInputSchema.parse({
    changeNumber: options.event.change.number,
    inlineItems: options.inlineItems,
    metadata: {
      ...options.metadata,
      cappedInlineFindings: options.inlineItems.length - publishedCount,
    },
    reviewState,
    threadActions: options.threadActions ?? [],
  });
  return {
    mainComment: renderMainComment({
      event: options.event,
      reviewState,
      maxStoredFindings: options.maxStoredFindings,
      main: options.main,
      metadata: input.metadata,
      showHeader: options.showHeader ?? true,
      showFooter: options.showFooter ?? true,
      showStats: options.showStats ?? true,
    }),
    mainMarker: mainCommentMarker,
    changeNumber: input.changeNumber,
    inlineItems: input.inlineItems.slice(0, publishedCount),
    metadata: input.metadata,
    reviewState: input.reviewState,
    threadActions: input.threadActions,
  };
}

function preparePublishableInlineFindings(options: {
  validated: {
    validFindings: ReviewFinding[];
  };
  manifest: DiffManifest;
}): PublishableInlineFinding[] {
  const ranges = createDiffRangeIndex(options.manifest);
  return options.validated.validFindings.flatMap((finding) => {
    const match = ranges.findRange(finding.rangeId);
    if (!match) {
      throw new Error(`Validated finding range '${finding.rangeId}' is missing from Diff Manifest`);
    }
    const { file, range } = match;
    const findingWithBody = findingWithPublishableBody(finding);
    if (!findingWithBody) {
      return [];
    }
    return [
      {
        finding: findingWithPublishableSuggestedFix(findingWithBody, range),
        range,
        previousPath: file.previousPath,
      },
    ];
  });
}

function prepareInlinePublicationItemsForPublishableFindings(options: {
  publishableFindings: PublishableInlineFinding[];
  reviewedHeadSha: string;
  reviewState?: PriorReviewState;
}): InlinePublicationItem[] {
  const seenFindingIds = new Set<string>();
  const fingerprintCounts = countFindingFingerprints(options.publishableFindings);
  return options.publishableFindings.flatMap(
    ({ finding: publishableFinding, range, previousPath, anchorFingerprint, issueFingerprint }) => {
      const stateRecord = options.reviewState
        ? matchFindingRecord(options.reviewState, publishableFinding)
        : undefined;
      const findingId = findingIdFor(publishableFinding, stateRecord);
      const resolvedRecord = options.reviewState
        ? matchResolvedFindingRecord(
            options.reviewState.findings,
            publishableFinding,
            anchorFingerprint,
            issueFingerprint,
            fingerprintCounts,
            previousPath,
          )
        : undefined;
      if (
        seenFindingIds.has(findingId) ||
        resolvedRecord !== undefined ||
        stateRecord?.lastCommentedHeadSha === options.reviewedHeadSha
      ) {
        return [];
      }
      seenFindingIds.add(findingId);
      return [
        {
          finding: publishableFinding,
          range,
          path: publishableFinding.path,
          previousPath,
          side: publishableFinding.side,
          startLine: publishableFinding.startLine,
          endLine: publishableFinding.endLine,
          marker: inlineFindingMarker(findingId, options.reviewedHeadSha),
          findingId,
          reviewedHeadSha: options.reviewedHeadSha,
          body: renderInlineBody(publishableFinding, findingId, options.reviewedHeadSha),
        },
      ];
    },
  );
}

function findingWithPublishableBody(finding: ReviewFinding): ReviewFinding | undefined {
  const body = finding.body.trim();
  if (body.length === 0) {
    return undefined;
  }
  return body === finding.body ? finding : { ...finding, body };
}

function findingWithPublishableSuggestedFix(
  finding: ReviewFinding,
  range: CommentableRange,
): ReviewFinding {
  if (!finding.suggestedFix) {
    return finding;
  }
  if (!isPublishableSuggestedFixSelection(finding, range)) {
    return withoutSuggestedFix(finding);
  }

  return finding;
}

function withoutSuggestedFix(finding: ReviewFinding): ReviewFinding {
  const next = { ...finding };
  delete next.suggestedFix;
  return next;
}

export type BuildCommentPublishingPlanOptions = {
  event: Pick<ChangeRequestEventContext, "change">;
  main: string;
  validated: ValidatedReview;
  manifest: DiffManifest;
  metadata: Omit<PublicationMetadata, "cappedInlineFindings">;
  maxInlineComments?: number;
  maxStoredFindings?: number;
  showHeader?: boolean;
  showFooter?: boolean;
  showStats?: boolean;
  priorReviewState?: PriorReviewState;
  threadActions?: ThreadAction[];
};

export type CommentPublishingPlan = {
  publicationPlan: PublicationPlan;
  inlineCommentDrafts: InlineCommentDraft[];
};

export function buildCommentPublishingPlan(
  options: BuildCommentPublishingPlanOptions,
): CommentPublishingPlan {
  const publishableInlineFindings = preparePublishableInlineFindings({
    validated: options.validated,
    manifest: options.manifest,
  }).map((item) => {
    const fingerprint = selectedCodeFingerprint(item.finding, item.range);
    return fingerprint
      ? {
          ...item,
          anchorFingerprint: fingerprint,
          issueFingerprint: findingIssueFingerprint(item.finding),
        }
      : item;
  });
  const reviewState = buildPriorReviewState({
    priorState: options.priorReviewState,
    findings: publishableInlineFindings,
    reviewedHeadSha: options.event.change.head.sha,
    selectedTasks: options.metadata.selectedTasks,
    stats: options.metadata.stats,
    workflowUrl: options.metadata.workflowUrl,
  });
  const inlineCommentDrafts = prepareInlinePublicationItemsForPublishableFindings({
    publishableFindings: publishableInlineFindings,
    reviewedHeadSha: options.event.change.head.sha,
    reviewState,
  });
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    main: options.main,
    inlineItems: inlineCommentDrafts,
    maxInlineComments: options.maxInlineComments,
    maxStoredFindings: options.maxStoredFindings,
    showHeader: options.showHeader,
    showFooter: options.showFooter,
    showStats: options.showStats,
    metadata: {
      ...options.metadata,
      ...(reviewState.stats ? { stats: reviewState.stats } : {}),
    },
    reviewState,
    threadActions: options.threadActions,
  });
  return {
    publicationPlan,
    inlineCommentDrafts: publicationPlan.inlineItems,
  };
}

function selectedCodeFingerprint(
  finding: ReviewFinding,
  range: CommentableRange,
): string | undefined {
  if (range.preview === undefined) {
    return undefined;
  }
  const lines = range.preview.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const startOffset = finding.startLine - range.startLine;
  const endOffset = finding.endLine - range.startLine + 1;
  if (startOffset < 0 || endOffset > lines.length) {
    return undefined;
  }
  const selected = lines
    .slice(startOffset, endOffset)
    .map((line) => line.trimEnd())
    .join("\n");
  return new Bun.CryptoHasher("sha256").update(selected).digest("hex");
}

function findingIssueFingerprint(finding: ReviewFinding): string | undefined {
  const normalized = finding.body
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<[^>]*>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N}_]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
  const identity = normalized || finding.body.normalize("NFKC").toLowerCase().trim();
  if (!identity) {
    return undefined;
  }
  return new Bun.CryptoHasher("sha256").update(identity).digest("hex");
}
