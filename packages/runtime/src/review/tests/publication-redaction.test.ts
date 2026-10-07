import { describe, expect, it } from "bun:test";
import type { ThreadAction } from "../../publication/types.js";
import type { ReviewFinding } from "../../types.js";
import { redactReviewPublication } from "../publication-redaction.js";
import { replacingRedactor } from "./task-runtime-fixtures.js";

const secret = "registered-runtime-secret";

const finding: ReviewFinding = {
  body: `Body mentions ${secret}.`,
  path: "src/a.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 10,
  endLine: 10,
  suggestedFix: `const token = "${secret}";`,
};

const fixedReply: ThreadAction = {
  kind: "resolve",
  findingId: "finding-1",
  findingHeadSha: "old-head",
  commentId: "comment-1",
  body: `Fixed in new-head; ${secret} is no longer logged.`,
  responseKey: "fixed:new-head",
};

describe("redactReviewPublication", () => {
  it("redacts the summary title, verifier replies, and valid findings before publication", () => {
    const cleanFix = { ...finding, rangeId: "range-2", suggestedFix: "const token = readToken();" };
    const redacted = redactReviewPublication({
      main: `Main mentions ${secret}.`,
      validated: {
        review: {
          summary: { title: `Title mentions ${secret}`, body: `Summary mentions ${secret}.` },
          inlineFindings: [finding],
        },
        validFindings: [finding, cleanFix],
        droppedFindings: [],
      },
      threadActions: [fixedReply],
      taskChecks: [],
      redactor: replacingRedactor(secret),
    });

    expect(redacted.main).toBe("Main mentions [redacted secret].");
    expect(redacted.validated.review.summary).toEqual({
      title: "Title mentions [redacted secret]",
      body: "Summary mentions [redacted secret].",
    });
    expect(redacted.threadActions).toEqual([
      { ...fixedReply, body: "Fixed in new-head; [redacted secret] is no longer logged." },
    ]);
    expect(redacted.validated.validFindings).toEqual([
      {
        body: "Body mentions [redacted secret].",
        path: "src/a.ts",
        rangeId: "range-1",
        side: "RIGHT",
        startLine: 10,
        endLine: 10,
      },
      { ...cleanFix, body: "Body mentions [redacted secret]." },
    ]);
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });
});
