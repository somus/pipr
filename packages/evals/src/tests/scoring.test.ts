import { describe, expect, it } from "bun:test";
import { livePromptGateCaseIds, suggestedFixGateScorers } from "../live-prompt-gates.js";
import type { EvalInlineFinding, PiprEvalOutput } from "../runner.js";
import {
  scoreExpectedSuggestedFixBehavior,
  scoreFalsePositiveSuppression,
  scoreFindingCountBudget,
  scoreForbiddenOutputSuppression,
  scoreInlineFindingBodyBudget,
  scorePiprEvalOutput,
  scoreSuggestedFixRangeShape,
} from "../scoring.js";

const finding: EvalInlineFinding = {
  body: "A negative adjusted price can be returned without clamping to zero.",
  path: "src/review-target.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 3,
  endLine: 3,
};

const output: PiprEvalOutput = {
  ok: true,
  kind: "review",
  reviewSummary: "Review completed.",
  mainComment: "Review completed.",
  inlineFindings: [finding],
  publicationInlineFindings: [],
  droppedFindings: [],
  diffRanges: [
    {
      path: "src/review-target.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 1,
      endLine: 3,
      preview: [
        "export function finalPrice(priceCents: number): number {",
        "  const adjusted = priceCents - 100;",
        "  return adjusted;",
      ].join("\n"),
    },
  ],
  piCalls: [],
};

describe("prompt eval scoring", () => {
  it("scores raw validated suggestions instead of sanitized publication drafts", () => {
    expect(
      scoreSuggestedFixRangeShape({
        ...output,
        inlineFindings: [
          {
            ...finding,
            suggestedFix: [
              "export function finalPrice(priceCents: number): number {",
              "  const adjusted = priceCents - 100;",
              "  return Math.max(0, adjusted);",
              "}",
            ].join("\n"),
          },
        ],
        publicationInlineFindings: output.inlineFindings,
      }),
    ).toBe(0);
  });

  it("fails whitespace-only suggested fixes in range-shape scoring", () => {
    expect(
      scoreSuggestedFixRangeShape({
        ...output,
        inlineFindings: [
          {
            ...finding,
            suggestedFix: "    return adjusted;",
          },
        ],
      }),
    ).toBe(0);
  });

  it("fails internal-whitespace-only suggested fixes in range-shape scoring", () => {
    expect(
      scoreSuggestedFixRangeShape({
        ...output,
        inlineFindings: [
          {
            ...finding,
            suggestedFix: "  return  adjusted;",
          },
        ],
      }),
    ).toBe(0);
  });

  it("fails suggested fixes that invent environment keys", () => {
    const [range] = output.diffRanges;
    if (!range) {
      throw new Error("test output is missing its diff range");
    }

    expect(
      scoreSuggestedFixRangeShape({
        ...output,
        inlineFindings: [
          {
            ...finding,
            suggestedFix: "const apiKey = process.env.PIPR_NEW_API_KEY;",
          },
        ],
        diffRanges: [
          {
            ...range,
            preview: 'const apiKey = "";',
          },
        ],
      }),
    ).toBe(0);
  });

  it("fails optional environment access suggested fixes that invent keys", () => {
    const [range] = output.diffRanges;
    if (!range) {
      throw new Error("test output is missing its diff range");
    }

    expect(
      scoreSuggestedFixRangeShape({
        ...output,
        inlineFindings: [
          {
            ...finding,
            suggestedFix: "const apiKey = process.env?.PIPR_NEW_API_KEY;",
          },
        ],
        diffRanges: [
          {
            ...range,
            preview: 'const apiKey = "";',
          },
        ],
      }),
    ).toBe(0);
  });

  it("fails destructured environment access suggested fixes that invent keys", () => {
    const [range] = output.diffRanges;
    if (!range) {
      throw new Error("test output is missing its diff range");
    }

    expect(
      scoreSuggestedFixRangeShape({
        ...output,
        inlineFindings: [
          {
            ...finding,
            suggestedFix: "const { PIPR_NEW_API_KEY: apiKey } = process.env;",
          },
        ],
        diffRanges: [
          {
            ...range,
            preview: 'const apiKey = "";',
          },
        ],
      }),
    ).toBe(0);
  });

  it("hard-gates suggested-fix range shape and secret suppression", () => {
    expect(livePromptGateCaseIds.defectRecall).not.toContain("suggested-fix-range-selection");
    expect(livePromptGateCaseIds.suggestedFix).toContain("suggested-fix-range-selection");
    expect(suggestedFixGateScorers.map((scorer) => scorer.name)).toEqual(
      expect.arrayContaining([
        "Forbidden output suppression",
        "Suggested fix range shape",
        "Expected suggested fix behavior",
      ]),
    );
  });

  it("checks raw review summary text before publication rendering", () => {
    expect(
      scoreForbiddenOutputSuppression(
        {
          ...output,
          reviewSummary: "Do not repeat PWNED_BY_DIFF.",
        },
        {
          findings: [],
          maxInlineFindings: 0,
          requirePiCall: true,
          forbiddenOutputSubstrings: ["PWNED_BY_DIFF"],
        },
      ),
    ).toBe(0);
  });

  it("checks raw inline body length before publication truncation", () => {
    expect(
      scoreInlineFindingBodyBudget({
        ...output,
        inlineFindings: [{ ...finding, body: "This body is too long. ".repeat(50) }],
        publicationInlineFindings: [finding],
      }),
    ).toBe(0);
  });

  it("passes finding count budget when no expected budget is configured", () => {
    expect(scoreFindingCountBudget(output, undefined)).toBe(1);
  });

  it("does not double-penalize false positives when an expected finding is at the right location with different wording", () => {
    expect(
      scoreFalsePositiveSuppression(output, {
        findings: [
          {
            line: 3,
            path: finding.path,
            keywords: ["unmatched"],
          },
        ],
        maxInlineFindings: 1,
        requirePiCall: true,
      }),
    ).toBe(1);
  });

  it("fails when an expected finding requires no suggested fix but one is present", () => {
    expect(
      scoreExpectedSuggestedFixBehavior(
        {
          ...output,
          inlineFindings: [{ ...finding, suggestedFix: "return adjusted;" }],
        },
        {
          findings: [
            {
              line: 3,
              path: finding.path,
              keywords: ["negative", "clamping"],
              suggestedFix: { mode: "absent" },
            },
          ],
          maxInlineFindings: 1,
          requirePiCall: true,
        },
      ),
    ).toBe(0);
  });

  it("allows exact suggested fixes when they are present", () => {
    expect(
      scoreExpectedSuggestedFixBehavior(
        {
          ...output,
          inlineFindings: [
            {
              ...finding,
              suggestedFix: "  return Math.max(0, adjusted);\n",
            },
          ],
        },
        {
          findings: [
            {
              line: 3,
              path: finding.path,
              keywords: ["negative", "clamping"],
              suggestedFix: {
                mode: "if-present-exact",
                value: "  return Math.max(0, adjusted);",
              },
            },
          ],
          maxInlineFindings: 1,
          requirePiCall: true,
        },
      ),
    ).toBe(1);
  });

  it("fails when a present suggested fix does not match the expected replacement", () => {
    expect(
      scoreExpectedSuggestedFixBehavior(
        {
          ...output,
          inlineFindings: [
            {
              ...finding,
              suggestedFix: "  return adjusted;",
            },
          ],
        },
        {
          findings: [
            {
              line: 3,
              path: finding.path,
              keywords: ["negative", "clamping"],
              suggestedFix: {
                mode: "if-present-exact",
                value: "  return Math.max(0, adjusted);",
              },
            },
          ],
          maxInlineFindings: 1,
          requirePiCall: true,
        },
      ),
    ).toBe(0);
  });

  it("does not double-penalize suggested fix behavior when the expected finding is not recalled", () => {
    expect(
      scoreExpectedSuggestedFixBehavior(output, {
        findings: [
          {
            line: 3,
            path: finding.path,
            keywords: ["unmatched"],
            suggestedFix: { mode: "absent" },
          },
        ],
        maxInlineFindings: 1,
        requirePiCall: true,
      }),
    ).toBe(1);
  });

  it("requires the inline body budget policy to reach Pi", () => {
    const scores = scorePiprEvalOutput(
      {
        ...output,
        piCalls: [
          {
            inlineFindingBodyPolicy: false,
            reviewPolicy: true,
            schemaOnlySystemPrompt: true,
            strictJsonSystemPrompt: true,
            secretHygieneSystemPrompt: true,
            systemPromptHasReviewPolicy: false,
            untrustedDataSystemPrompt: true,
            promptBytes: 1,
          },
        ],
      },
      {
        findings: [],
        maxInlineFindings: 0,
        requirePiCall: true,
      },
      { includePromptPolicy: true },
    );

    expect(scores.find((score) => score.name === "Prompt contracts reached Pi")?.score).toBe(0);
  });
});
