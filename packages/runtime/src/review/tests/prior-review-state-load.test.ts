import { describe, expect, it } from "bun:test";
import type { PriorFindingRecord, PriorReviewState } from "../../publication/types.js";
import {
  renderInlineFindingMarker,
  renderResolvedFindingMarker,
  renderVerifierResponseMarker,
} from "../comment-markers.js";
import { reconcilePriorReviewState } from "../prior-review-state-load.js";

const findingId = "fnd_0123456789abcdef";
const headSha = "a".repeat(40);
const head12 = headSha.slice(0, 12);

function stored(overrides: Partial<PriorFindingRecord> = {}): PriorReviewState {
  return {
    version: 2,
    reviewedHeadSha: headSha,
    selectedTasks: ["review"],
    findings: [
      {
        id: findingId,
        status: "open",
        path: "src/a.ts",
        rangeId: "range-1",
        side: "RIGHT",
        startLine: 1,
        endLine: 1,
        firstSeenHeadSha: headSha,
        lastSeenHeadSha: headSha,
        a: "security-reviewer",
        m: "deepseek-v4-pro",
        f: { severity: "high" },
        h: [["p", head12]],
        ...overrides,
      },
    ],
  };
}

const inline = (resolved?: boolean) => ({
  body: `${renderInlineFindingMarker(findingId, headSha)}\n\nUnchecked input.`,
  ...(resolved === undefined ? {} : { resolved }),
});
const attribution = {
  agent: "security-reviewer",
  model: "deepseek-v4-pro",
  facets: { severity: "high" },
};

describe("reconcilePriorReviewState", () => {
  it("keeps published history only where an inline comment confirms the post", () => {
    const confirmed = reconcilePriorReviewState({
      prior: stored(),
      inline: [inline()],
      replyBodies: [],
      threadResolution: "available",
    });
    const unconfirmed = reconcilePriorReviewState({
      prior: stored(),
      inline: [],
      replyBodies: [],
      threadResolution: "available",
    });

    expect(confirmed.state.findings[0]?.h).toEqual([["p", head12]]);
    expect(confirmed.state.findings[0]?.lastCommentedHeadSha).toBe(headSha);
    expect(unconfirmed.state.findings[0]?.h).toBeUndefined();
    expect(confirmed.events).toEqual([]);
  });

  it("reports a natively resolved thread without a Pipr resolution as resolved-by-human, noting it once", () => {
    const first = reconcilePriorReviewState({
      prior: stored(),
      inline: [inline(true)],
      replyBodies: [],
      threadResolution: "available",
    });
    expect(first.events).toEqual([
      {
        kind: "resolved-by-human",
        findingId,
        anchor: `human-resolved:${headSha}`,
        attribution,
      },
    ]);
    expect(first.state.findings[0]).toMatchObject({
      status: "resolved",
      h: [
        ["p", head12],
        ["h", head12],
      ],
    });

    const next = reconcilePriorReviewState({
      prior: first.state,
      inline: [inline(true)],
      replyBodies: [],
      threadResolution: "available",
    });
    // Every load re-reports the outcome with the same anchor, so a surviving bundle carries it
    // even when the bundle that first recorded it is gone; history notes it only once.
    expect(next.events).toEqual(first.events);
    expect(next.state.findings[0]?.h).toEqual([
      ["p", head12],
      ["h", head12],
    ]);
  });

  it("reports a thread Pipr resolved as fixed, not as resolved by a human", () => {
    const loaded = reconcilePriorReviewState({
      prior: stored(),
      inline: [inline(true)],
      replyBodies: [`${renderResolvedFindingMarker(findingId, headSha)}\n\nFixed.`],
      threadResolution: "available",
    });

    expect(loaded.events).toEqual([
      { kind: "fixed", findingId, anchor: `pipr-resolved:${headSha}`, attribution },
    ]);
    const recorded = reconcilePriorReviewState({
      prior: stored({ h: [["f", "b".repeat(12)]] }),
      inline: [inline(true)],
      replyBodies: [`${renderResolvedFindingMarker(findingId, headSha)}\n\nFixed.`],
      threadResolution: "available",
    });
    expect(recorded.events).toEqual(loaded.events);
    expect(recorded.state.findings[0]?.h).toEqual([["f", "b".repeat(12)]]);
  });

  it("rebuilds still-valid verifier replies as replied by an unknown actor and still-valid", () => {
    const responseKey = `reply-42:thread-7:still-valid:${findingId}`;
    const replyBodies = [
      "The caller validates this.",
      `${renderVerifierResponseMarker(findingId, responseKey)}\n\nStill applies.`,
    ];
    const loaded = reconcilePriorReviewState({
      prior: stored(),
      inline: [inline(false)],
      replyBodies,
      threadResolution: "available",
    });

    expect(loaded.events).toEqual([
      {
        kind: "replied",
        findingId,
        actorPermission: "unknown",
        anchor: "reply:thread-7:42",
        attribution,
      },
      {
        kind: "still-valid",
        findingId,
        anchor: `verifier-response:${responseKey}`,
        attribution,
      },
    ]);
    const reloaded = reconcilePriorReviewState({
      prior: loaded.state,
      inline: [inline(false)],
      replyBodies,
      threadResolution: "available",
    });
    expect(reloaded.events).toEqual(loaded.events);
    expect(reloaded.state.findings[0]?.h).toEqual(loaded.state.findings[0]?.h);
  });

  it("observes no human resolution where the host has no thread resolution", () => {
    const loaded = reconcilePriorReviewState({
      prior: stored(),
      inline: [inline(true)],
      replyBodies: [],
      threadResolution: "unavailable",
    });

    expect(loaded.threadResolution).toBe("unavailable");
    expect(loaded.events).toEqual([]);
    expect(loaded.state.findings[0]?.status).toBe("open");
  });
});
