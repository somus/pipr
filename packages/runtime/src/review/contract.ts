import { reviewOutputSchemaId } from "@usepipr/sdk/internal";
import {
  parseReviewResult,
  type ReviewResult,
  reviewFindingSchema,
  reviewResultSchema,
  type ReviewFinding as SdkReviewFinding,
  reviewSchemaExample as sdkReviewSchemaExample,
} from "@usepipr/sdk/review";
import { z } from "zod";

export const prReviewSchemaId = reviewOutputSchemaId;

export { reviewFindingSchema };

export const prReviewSchema = reviewResultSchema;

export type ReviewFinding = SdkReviewFinding;
export type PrReview = ReviewResult;

export const prReviewJsonSchema = z.toJSONSchema(prReviewSchema);

export function parsePrReview(value: unknown): PrReview {
  return prReviewSchema.parse(parseReviewResult(value)) as PrReview;
}

export function reviewSchemaExample(): PrReview {
  return parsePrReview(sdkReviewSchemaExample());
}
