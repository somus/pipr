import { describe, expect, it } from "bun:test";
import type { InlinePublicationItem } from "../../review/comment.js";
import { renderInlineFindingMarker } from "../../review/prior-state.js";
import { publishUnseenInlineItems } from "../publication.js";

describe("shared code host publication", () => {
  it("reconciles an accepted inline write without duplicating it", async () => {
    const bodies: string[] = [];
    let writes = 0;

    const result = await publishUnseenInlineItems({
      items: [inlineItem()],
      existingBodies: [],
      reloadExistingBodies: async () => bodies,
      sleep: async () => {
        throw new Error("accepted writes must reconcile before sleeping");
      },
      publish: async (item) => {
        writes += 1;
        bodies.push(item.body);
        throw Object.assign(new Error("response lost"), { status: 503 });
      },
    });

    expect(result).toEqual({ posted: 1, skipped: 0, errors: [] });
    expect(writes).toBe(1);
    expect(bodies).toHaveLength(1);
  });

  it("retries a missing inline write and records its marker for later items", async () => {
    const item = inlineItem();
    let writes = 0;
    const result = await publishUnseenInlineItems({
      items: [item, item],
      existingBodies: [],
      reloadExistingBodies: async () => [],
      sleep: async () => {},
      publish: async () => {
        writes += 1;
        if (writes === 1) throw Object.assign(new Error("unavailable"), { status: 503 });
      },
    });

    expect(result).toEqual({ posted: 1, skipped: 1, errors: [] });
    expect(writes).toBe(2);
  });

  it("does not treat an unowned marker-like body as published", async () => {
    let writes = 0;
    const item = inlineItem();
    const result = await publishUnseenInlineItems({
      items: [item],
      existingBodies: [`quoted ${item.body}`],
      publish: async () => {
        writes += 1;
      },
    });

    expect(result).toEqual({ posted: 1, skipped: 0, errors: [] });
    expect(writes).toBe(1);
  });
});

function inlineItem(): InlinePublicationItem {
  const finding = {
    body: "Fix this.",
    path: "src/a.ts",
    rangeId: "range-1",
    side: "RIGHT" as const,
    startLine: 2,
    endLine: 2,
  };
  return {
    finding,
    range: {
      id: "range-1",
      path: "src/a.ts",
      side: "RIGHT",
      startLine: 2,
      endLine: 2,
      kind: "added",
      hunkIndex: 1,
      hunkHeader: "@@ -1 +1,2 @@",
      hunkContentHash: "deadbeefcafe",
    },
    path: "src/a.ts",
    side: "RIGHT",
    startLine: 2,
    endLine: 2,
    body: `${renderInlineFindingMarker("finding-1", "head")}\nFix this.`,
    marker: "pipr:finding:finding-1:head",
    findingId: "finding-1",
    reviewedHeadSha: "head",
  };
}
