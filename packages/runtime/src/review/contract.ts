import {
  parseReviewResult,
  type ReviewFinding,
  type ReviewResult,
  reviewFindingSchema,
  reviewResultSchema,
  reviewSchemaExample as sdkReviewSchemaExample,
} from "@usepipr/sdk";
import { reviewOutputSchemaId } from "@usepipr/sdk/internal";

export const reviewResultSchemaId = reviewOutputSchemaId;

export type { ReviewFinding, ReviewResult };
export { reviewFindingSchema, reviewResultSchema };

export function reviewSchemaExample(): ReviewResult {
  return parseReviewResult(sdkReviewSchemaExample());
}
