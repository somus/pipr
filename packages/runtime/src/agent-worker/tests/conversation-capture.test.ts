import { describe, expect, it } from "bun:test";
import { captureConversation } from "../conversation-capture.js";

type Page = { items: Array<{ id: number; kind: string }>; next?: number };

function conversation(pages: Array<Page | Error>) {
  return {
    async entries(_query: object, _limit: number, cursor: number | undefined) {
      const page = pages[cursor ?? 0];
      if (!page || page instanceof Error) throw page ?? new Error("missing page");
      return page;
    },
  };
}

describe("conversation capture", () => {
  it("returns committed entries oldest first", async () => {
    const record = await captureConversation(
      conversation([
        { items: [{ id: 3, kind: "pi.assistant" }], next: 1 },
        { items: [{ id: 1, kind: "pi.user" }] },
      ]),
    );

    expect(record).toEqual({
      entries: [
        { id: 1, kind: "pi.user" },
        { id: 3, kind: "pi.assistant" },
      ],
      truncated: false,
    });
  });

  it("returns no conversation when the store fails while paging entries", async () => {
    const record = await captureConversation(
      conversation([{ items: [{ id: 3, kind: "pi.assistant" }], next: 1 }, new Error("disk I/O")]),
    );

    expect(record).toBeUndefined();
  });
});
