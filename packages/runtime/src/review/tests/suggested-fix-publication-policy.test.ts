import { describe, expect, it } from "bun:test";
import { isPublishableSuggestedFixSelection } from "../suggested-fix-publication-policy.js";

type Selection = {
  side: "RIGHT" | "LEFT";
  kind: "added" | "deleted" | "context" | "mixed";
  rangeStartLine: number;
  startLine: number;
  endLine: number;
  preview?: string;
  suggestedFix: string;
};

function isPublishable(selection: Selection): boolean {
  return isPublishableSuggestedFixSelection(
    {
      startLine: selection.startLine,
      endLine: selection.endLine,
      suggestedFix: selection.suggestedFix,
    },
    {
      side: selection.side,
      kind: selection.kind,
      startLine: selection.rangeStartLine,
      preview: selection.preview,
    },
  );
}

const publishable: Selection = {
  side: "RIGHT",
  kind: "added",
  rangeStartLine: 10,
  startLine: 11,
  endLine: 11,
  preview: ["before();", "fail();", "after();"].join("\n"),
  suggestedFix: "recover();",
};

const lines = (count: number, prefix: string) =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}();`).join("\n");

describe("isPublishableSuggestedFixSelection", () => {
  it("publishes a bounded RIGHT-side replacement that changes the selected lines", () => {
    expect(isPublishable(publishable)).toBe(true);
    expect(
      isPublishable({
        ...publishable,
        suggestedFix: ["recover();", "log();"].join("\n"),
      }),
    ).toBe(true);
    expect(
      isPublishable({
        ...publishable,
        startLine: 10,
        endLine: 21,
        preview: lines(12, "old"),
        suggestedFix: lines(12, "new"),
      }),
    ).toBe(true);
    expect(isPublishable({ ...publishable, suggestedFix: lines(20, "new") })).toBe(true);
  });

  it.each<[string, Partial<Selection>]>([
    ["LEFT-side selections", { side: "LEFT" }],
    ["deleted ranges", { kind: "deleted" }],
    [
      "more than 12 selected lines",
      { startLine: 10, endLine: 22, preview: lines(13, "old"), suggestedFix: lines(13, "new") },
    ],
    ["more than 20 replacement lines", { suggestedFix: lines(21, "new") }],
    ["a missing preview", { preview: undefined }],
    [
      "an unchanged first selected line",
      { startLine: 10, endLine: 11, suggestedFix: ["before();", "recover();"].join("\n") },
    ],
    [
      "an unchanged last selected line",
      { startLine: 10, endLine: 11, suggestedFix: ["recover();", "fail();"].join("\n") },
    ],
    [
      "a fix that repeats the unselected following line",
      { suggestedFix: ["recover();", "after();"].join("\n") },
    ],
    [
      "a fix that repeats the unselected preceding line",
      { suggestedFix: ["before();", "recover();"].join("\n") },
    ],
  ])("does not publish %s", (_label, patch) => {
    expect(isPublishable({ ...publishable, ...patch })).toBe(false);
  });
});
