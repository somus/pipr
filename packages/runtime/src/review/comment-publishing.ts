import type {
  ChangeRequestEventContext,
  CommentableRange,
  DiffManifest,
  ReviewFinding,
  ValidatedReview,
} from "../types.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type PublicationMetadata,
  type PublicationPlan,
  prepareInlinePublicationItemsForPublishableFindings,
  preparePublishableInlineFindings,
  type ThreadAction,
} from "./comment.js";
import { buildPriorReviewState, type PriorReviewState } from "./prior-state.js";

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
    const fingerprint = item.finding.issueKey
      ? selectedCodeFingerprint(item.finding, item.range)
      : undefined;
    return fingerprint ? { ...item, anchorFingerprint: fingerprint } : item;
  });
  const reviewState = buildPriorReviewState({
    priorState: options.priorReviewState,
    findings: publishableInlineFindings,
    reviewedHeadSha: options.event.change.head.sha,
    selectedTasks: options.metadata.selectedTasks,
    stats: options.metadata.stats,
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
  const selected = lines
    .slice(startOffset, endOffset)
    .map((line) => line.trimEnd())
    .join("\n");
  if (startOffset < 0 || endOffset > lines.length) {
    return undefined;
  }
  return new Bun.CryptoHasher("sha256").update(selected).digest("hex");
}
