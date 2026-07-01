import type { ChangeRequestEventContext, DiffManifest, ValidatedReview } from "../types.js";
import {
  buildPublicationPlan,
  type InlineCommentDraft,
  type PublicationMetadata,
  type PublicationPlan,
  prepareInlinePublicationItems,
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
  const reviewState = buildPriorReviewState({
    priorState: options.priorReviewState,
    findings: options.validated.validFindings,
    reviewedHeadSha: options.event.change.head.sha,
    selectedTasks: options.metadata.selectedTasks,
  }).state;
  const inlineCommentDrafts = prepareInlinePublicationItems({
    validated: options.validated,
    manifest: options.manifest,
    reviewedHeadSha: options.event.change.head.sha,
    reviewState,
  });
  const publicationPlan = buildPublicationPlan({
    event: options.event,
    main: options.main,
    inlineItems: inlineCommentDrafts,
    maxInlineComments: options.maxInlineComments,
    metadata: options.metadata,
    reviewState,
    threadActions: options.threadActions,
  });
  return {
    publicationPlan,
    inlineCommentDrafts: publicationPlan.inlineItems,
  };
}
