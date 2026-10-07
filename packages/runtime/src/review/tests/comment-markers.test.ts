import { describe, expect, it } from "bun:test";
import type { PriorReviewState } from "../../publication/types.js";
import { extractPriorReviewState, renderMainCommentMarker } from "../comment-markers.js";

const state: PriorReviewState = {
  version: 1,
  reviewedHeadSha: "head",
  selectedTasks: ["security", "review"],
  findings: [],
};

const marker = renderMainCommentMarker({
  marker: "pipr:main-comment",
  changeNumber: 7,
  reviewState: state,
});

describe("main comment marker", () => {
  it("reads state only from a first-line marker for the same change", () => {
    expect(extractPriorReviewState(`${marker}\n\nSummary.`, 7)).toEqual(state);
    expect(extractPriorReviewState(`\n\n${marker}\nSummary.`, 7)).toEqual(state);
    expect(extractPriorReviewState(`${marker}\nSummary.`, 8)).toBeUndefined();
    expect(extractPriorReviewState(`Summary.\n${marker}`, 7)).toBeUndefined();
    expect(extractPriorReviewState(`${marker}\n`, 7, "pipr:other-comment")).toBeUndefined();
  });
});
