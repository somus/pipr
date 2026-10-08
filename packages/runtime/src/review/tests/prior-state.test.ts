import { describe, expect, it } from "bun:test";
import type { PriorReviewState } from "../../publication/types.js";
import { priorReviewStateForSelectedTasks } from "../prior-state.js";

const state: PriorReviewState = {
  version: 2,
  reviewedHeadSha: "head",
  selectedTasks: ["security", "review"],
  findings: [],
};

describe("prior review state identity", () => {
  it("reuses state only for the same selected tasks in the same order", () => {
    expect(priorReviewStateForSelectedTasks(state, ["security", "review"])).toBe(state);
    expect(priorReviewStateForSelectedTasks(state, ["review", "security"])).toBeUndefined();
    expect(priorReviewStateForSelectedTasks(state, ["security"])).toBeUndefined();
    expect(priorReviewStateForSelectedTasks(undefined, ["security", "review"])).toBeUndefined();
  });
});
