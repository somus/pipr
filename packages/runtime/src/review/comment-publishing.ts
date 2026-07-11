import type { ChangeRequestEventContext, DiffManifest, ValidatedReview } from "../types.js";
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
  });
  const reviewState = buildPriorReviewState({
    priorState: options.priorReviewState,
    findings: publishableInlineFindings.map((item) => item.finding),
    reviewedHeadSha: options.event.change.head.sha,
    selectedTasks: options.metadata.selectedTasks,
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
    showHeader: options.showHeader,
    showFooter: options.showFooter,
    showStats: options.showStats,
    metadata: options.metadata,
    reviewState,
    threadActions: options.threadActions,
  });
  return {
    publicationPlan,
    inlineCommentDrafts: publicationPlan.inlineItems,
  };
}
