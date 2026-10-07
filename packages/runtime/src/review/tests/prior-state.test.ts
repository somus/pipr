import { describe, expect, it } from "bun:test";
import type { PriorReviewState } from "../../publication/types.js";
import {
  extractPriorReviewState,
  priorReviewStateForSelectedTasks,
  renderMainCommentMarker,
} from "../prior-state.js";

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

describe("prior review state identity", () => {
  it("reads state only from a first-line marker for the same change", () => {
    expect(extractPriorReviewState(`${marker}\n\nSummary.`, 7)).toEqual(state);
    expect(extractPriorReviewState(`\n\n${marker}\nSummary.`, 7)).toEqual(state);
    expect(extractPriorReviewState(`${marker}\nSummary.`, 8)).toBeUndefined();
    expect(extractPriorReviewState(`Summary.\n${marker}`, 7)).toBeUndefined();
    expect(extractPriorReviewState(`${marker}\n`, 7, "pipr:other-comment")).toBeUndefined();
  });

  it("reuses state only for the same selected tasks in the same order", () => {
    expect(priorReviewStateForSelectedTasks(state, ["security", "review"])).toBe(state);
    expect(priorReviewStateForSelectedTasks(state, ["review", "security"])).toBeUndefined();
    expect(priorReviewStateForSelectedTasks(state, ["security"])).toBeUndefined();
    expect(priorReviewStateForSelectedTasks(undefined, ["security", "review"])).toBeUndefined();
  });
});
