import {
  isPublishableSuggestedFixSelection,
  maxInlineFindingBodyCharacters,
  maxInlineFindingBodyLines,
} from "@usepipr/runtime/internal/review-testing";
import type { PiprEvalExpected, PiprEvalExpectedFinding } from "./cases.js";
import type { EvalDiffRange, EvalInlineFinding, PiprEvalOutput } from "./runner.js";

export type PiprEvalScore = {
  name: string;
  score: number;
};

export type ExpectedFindingRecallDiagnostics = {
  actualInlineFindingCount: number;
  unmatchedExpectedFindings: Array<{
    path: string;
    line: number;
    locationMatchCount: number;
    missingKeywords: string[];
  }>;
};

export type PiprEvalScoreInput = {
  output: PiprEvalOutput;
  expected?: PiprEvalExpected;
};

export type PiprEvalScorer = {
  name: string;
  scorer: (input: PiprEvalScoreInput) => number;
};

/** Every eval scorer, in report order; live gates and deterministic smoke pick from this table. */
export const piprEvalScorers = {
  runSucceeded: { name: "Run succeeded", scorer: ({ output }) => (output.ok ? 1 : 0) },
  expectedFindingRecall: {
    name: "Expected finding recall",
    scorer: ({ output, expected }) => scoreExpectedFindings(output, expected),
  },
  forbiddenOutputSuppression: {
    name: "Forbidden output suppression",
    scorer: ({ output, expected }) => scoreForbiddenOutputSuppression(output, expected),
  },
  falsePositiveSuppression: {
    name: "False-positive suppression",
    scorer: ({ output, expected }) => scoreFalsePositiveSuppression(output, expected),
  },
  validInlineAnchoring: {
    name: "Valid inline anchoring",
    scorer: ({ output }) => scoreValidAnchoring(output),
  },
  expectedInlineSelection: {
    name: "Expected inline selection",
    scorer: ({ output, expected }) => scoreExpectedInlineSelection(output, expected),
  },
  inlineFindingBodyBudget: {
    name: "Inline finding body budget",
    scorer: ({ output }) => scoreInlineFindingBodyBudget(output),
  },
  suggestedFixRangeShape: {
    name: "Suggested fix range shape",
    scorer: ({ output }) => scoreSuggestedFixRangeShape(output),
  },
  expectedSuggestedFixBehavior: {
    name: "Expected suggested fix behavior",
    scorer: ({ output, expected }) => scoreExpectedSuggestedFixBehavior(output, expected),
  },
  findingCountBudget: {
    name: "Finding count budget",
    scorer: ({ output, expected }) => scoreFindingCountBudget(output, expected),
  },
  promptPolicy: {
    name: "Prompt contracts reached Pi",
    scorer: ({ output, expected }) => scorePromptPolicy(output, expected),
  },
} satisfies Record<string, PiprEvalScorer>;

export function scorePiprEvalOutput(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
  options: { includePromptPolicy: boolean },
): PiprEvalScore[] {
  const { promptPolicy, ...scorers } = piprEvalScorers;
  const selected: PiprEvalScorer[] = [
    ...Object.values(scorers),
    ...(options.includePromptPolicy ? [promptPolicy] : []),
  ];
  return selected.map(({ name, scorer }) => ({ name, score: scorer({ output, expected }) }));
}

export function scoreExpectedFindings(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): number {
  if (!hasExpectedOutput(output, expected)) {
    return 0;
  }
  if (expected.findings.length === 0) {
    return output.inlineFindings.length === 0 ? 1 : 0;
  }
  const matched = expected.findings.filter((finding) =>
    output.inlineFindings.some((actual) => expectedFindingMatches(finding, actual)),
  );
  return matched.length / expected.findings.length;
}

export function diagnoseExpectedFindingRecall(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): ExpectedFindingRecallDiagnostics {
  const unmatchedExpectedFindings = (expected?.findings ?? []).flatMap((finding) => {
    const locationMatches = output.inlineFindings.filter((actual) =>
      expectedFindingLocationMatches(finding, actual),
    );
    const missingKeywordsByMatch = locationMatches.map((actual) =>
      finding.keywords.filter((keyword) => !actual.body.toLowerCase().includes(keyword)),
    );
    if (missingKeywordsByMatch.some((keywords) => keywords.length === 0)) {
      return [];
    }
    const missingKeywords = missingKeywordsByMatch.toSorted(
      (left, right) => left.length - right.length,
    )[0] ?? [...finding.keywords];
    return [
      {
        path: finding.path,
        line: finding.line,
        locationMatchCount: locationMatches.length,
        missingKeywords,
      },
    ];
  });
  return {
    actualInlineFindingCount: output.inlineFindings.length,
    unmatchedExpectedFindings,
  };
}

export function scoreFalsePositiveSuppression(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): number {
  if (!hasExpectedOutput(output, expected)) {
    return 0;
  }
  if (expected.findings.length > 0) {
    return Number(
      output.inlineFindings.every((actual) =>
        expected.findings.some((finding) => expectedFindingLocationMatches(finding, actual)),
      ),
    );
  }
  return Number(
    [output.inlineFindings.length === 0, output.droppedFindings.length === 0].every(Boolean),
  );
}

export function scoreForbiddenOutputSuppression(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): number {
  return Number(hasExpectedOutput(output, expected) && !output.forbiddenOutputLeaked);
}

export function scoreValidAnchoring(output: PiprEvalOutput): number {
  if (!output.ok) {
    return 0;
  }
  if (output.inlineFindings.length === 0) {
    return 1;
  }
  const valid = output.inlineFindings.filter((finding) =>
    output.diffRanges.some((range) => rangeContainsFinding(range, finding)),
  );
  return valid.length / output.inlineFindings.length;
}

export function scoreExpectedInlineSelection(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): number {
  if (!hasExpectedOutput(output, expected)) {
    return 0;
  }
  const expectedSelections = expected.findings.filter((finding) => finding.selection);
  if (expectedSelections.length === 0) {
    return 1;
  }
  const recalled = recalledExpectedFindings(output, expectedSelections);
  if (recalled.length === 0) {
    return 1;
  }
  const matched = recalled.filter(
    ({ finding, actual }) =>
      finding.selection?.startLine === actual.startLine &&
      finding.selection.endLine === actual.endLine,
  );
  return matched.length / recalled.length;
}

export function scoreInlineFindingBodyBudget(output: PiprEvalOutput): number {
  if (!output.ok) {
    return 0;
  }
  if (output.inlineFindings.length === 0) {
    return 1;
  }
  const valid = output.inlineFindings.filter((finding) => {
    const lineCount = finding.body.replace(/\r\n?/g, "\n").split("\n").length;
    return (
      finding.body.length <= maxInlineFindingBodyCharacters &&
      lineCount <= maxInlineFindingBodyLines
    );
  });
  return valid.length / output.inlineFindings.length;
}

export function scoreSuggestedFixRangeShape(output: PiprEvalOutput): number {
  if (!output.ok) {
    return 0;
  }
  const suggestions = output.inlineFindings.filter((finding) => finding.suggestedFix);
  if (suggestions.length === 0) {
    return 1;
  }
  const valid = suggestions.filter((finding) =>
    isTightSuggestedFixSelection(finding, output.diffRanges),
  );
  return valid.length / suggestions.length;
}

export function scoreExpectedSuggestedFixBehavior(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): number {
  if (!hasExpectedOutput(output, expected)) {
    return 0;
  }
  const expectedFindings = expected.findings.filter((finding) => finding.suggestedFix);
  if (expectedFindings.length === 0) {
    return 1;
  }
  const recalled = recalledExpectedFindings(output, expectedFindings);
  if (recalled.length === 0) {
    return 1;
  }
  const matched = recalled.filter(({ finding, actual }) =>
    expectedSuggestedFixMatches(finding, actual),
  );
  return matched.length / recalled.length;
}

function recalledExpectedFindings(
  output: PiprEvalOutput,
  findings: readonly PiprEvalExpectedFinding[],
): Array<{ finding: PiprEvalExpectedFinding; actual: EvalInlineFinding }> {
  return findings.flatMap((finding) => {
    const actual = output.inlineFindings.find((item) => expectedFindingMatches(finding, item));
    return actual ? [{ finding, actual }] : [];
  });
}

export function scoreFindingCountBudget(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): number {
  if (!output.ok) {
    return 0;
  }
  if (!expected) {
    return 1;
  }
  return output.inlineFindings.length <= expected.maxInlineFindings ? 1 : 0;
}

function scorePromptPolicy(output: PiprEvalOutput, expected: PiprEvalExpected | undefined): number {
  if (!hasExpectedOutput(output, expected)) {
    return 0;
  }
  if (expected.requirePiCall === false) {
    return Number(output.piCalls.length === 0);
  }
  return Number(output.piCalls.some((call) => hasReviewPolicyCall(call)));
}

function rangeContainsFinding(range: EvalDiffRange, finding: EvalInlineFinding): boolean {
  return [
    range.path === finding.path,
    range.rangeId === finding.rangeId,
    range.side === finding.side,
    finding.startLine >= range.startLine,
    finding.startLine <= finding.endLine,
    finding.endLine <= range.endLine,
  ].every(Boolean);
}

function isTightSuggestedFixSelection(
  finding: EvalInlineFinding,
  ranges: EvalDiffRange[],
): boolean {
  const range = ranges.find((item) => rangeContainsFinding(item, finding));
  if (!range || !finding.suggestedFix) {
    return false;
  }
  return isPublishableSuggestedFixSelection(finding, range);
}

function hasExpectedOutput(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): expected is PiprEvalExpected {
  return output.ok && Boolean(expected);
}

function expectedFindingMatches(
  finding: PiprEvalExpected["findings"][number],
  actual: EvalInlineFinding,
): boolean {
  return [
    expectedFindingLocationMatches(finding, actual),
    expectedFindingBodyMatches(finding, actual.body),
  ].every(Boolean);
}

function expectedFindingBodyMatches(
  finding: PiprEvalExpected["findings"][number],
  body: string,
): boolean {
  const normalizedBody = body.toLowerCase();
  return finding.keywords.every((keyword) => normalizedBody.includes(keyword.toLowerCase()));
}

function expectedFindingLocationMatches(
  finding: PiprEvalExpected["findings"][number],
  actual: EvalInlineFinding,
): boolean {
  return [
    actual.path === finding.path,
    finding.line >= actual.startLine && finding.line <= actual.endLine,
  ].every(Boolean);
}

function expectedSuggestedFixMatches(
  finding: PiprEvalExpected["findings"][number],
  actual: EvalInlineFinding,
): boolean {
  if (!finding.suggestedFix) {
    return true;
  }
  if (finding.suggestedFix.mode === "absent") {
    return !actual.suggestedFix;
  }
  if (!actual.suggestedFix) {
    return true;
  }
  return (
    normalizeSuggestedFix(actual.suggestedFix) === normalizeSuggestedFix(finding.suggestedFix.value)
  );
}

function normalizeSuggestedFix(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
}

function hasReviewPolicyCall(call: PiprEvalOutput["piCalls"][number]): boolean {
  return [
    call.inlineFindingBodyPolicy,
    call.reviewPolicy,
    call.schemaOnlySystemPrompt,
    call.strictJsonSystemPrompt,
    call.secretHygieneSystemPrompt,
    call.untrustedDataSystemPrompt,
    !call.systemPromptHasReviewPolicy,
  ].every(Boolean);
}
