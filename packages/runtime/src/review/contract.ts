import {
  parseReviewResult,
  type ReviewFinding,
  type ReviewResult,
  reviewFindingSchema,
  reviewResultSchema,
  reviewSchemaExample as sdkReviewSchemaExample,
} from "@usepipr/sdk";
import { reviewOutputSchemaId } from "@usepipr/sdk/internal";
import { z } from "zod";

export const reviewResultSchemaId = reviewOutputSchemaId;

export type { ReviewFinding, ReviewResult };
export { parseReviewResult, reviewFindingSchema, reviewResultSchema };

export const reviewResultJsonSchema = z.toJSONSchema(reviewResultSchema);

export function reviewSchemaExample(): ReviewResult {
  return parseReviewResult(sdkReviewSchemaExample());
}
