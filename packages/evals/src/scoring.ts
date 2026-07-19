import {
  isPublishableSuggestedFixSelection,
  maxInlineFindingBodyCharacters,
  maxInlineFindingBodyLines,
} from "@usepipr/runtime/internal/review-testing";
import type { PiprEvalExpected, PiprEvalExpectedFinding } from "./cases.js";
import type { EvalDiffRange, EvalInlineFinding, PiprEvalOutput } from "./runner.js";
import { piprEvalForbiddenOutputText } from "./runner.js";

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

export function scorePiprEvalOutput(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
  options: { includePromptPolicy: boolean },
): PiprEvalScore[] {
  return [
    { name: "Run succeeded", score: output.ok ? 1 : 0 },
    { name: "Expected finding recall", score: scoreExpectedFindings(output, expected) },
    {
      name: "Forbidden output suppression",
      score: scoreForbiddenOutputSuppression(output, expected),
    },
    {
      name: "False-positive suppression",
      score: scoreFalsePositiveSuppression(output, expected),
    },
    { name: "Valid inline anchoring", score: scoreValidAnchoring(output) },
    {
      name: "Expected inline selection",
      score: scoreExpectedInlineSelection(output, expected),
    },
    { name: "Inline finding body budget", score: scoreInlineFindingBodyBudget(output) },
    { name: "Suggested fix range shape", score: scoreSuggestedFixRangeShape(output) },
    {
      name: "Expected suggested fix behavior",
      score: scoreExpectedSuggestedFixBehavior(output, expected),
    },
    { name: "Finding count budget", score: scoreFindingCountBudget(output, expected) },
    ...(options.includePromptPolicy
      ? [{ name: "Prompt contracts reached Pi", score: scorePromptPolicy(output, expected) }]
      : []),
  ];
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
  return Number(
    hasExpectedOutput(output, expected) &&
      forbiddenOutputSuppressed(output, expected.forbiddenOutputSubstrings ?? []),
  );
}

function forbiddenOutputSuppressed(output: PiprEvalOutput, forbidden: string[]): boolean {
  if (forbidden.length === 0) {
    return true;
  }
  const text = piprEvalForbiddenOutputText(output).toLowerCase();
  return forbidden.every((value) => !text.includes(value.toLowerCase()));
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
  if (!expected.requirePiCall) {
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
  return isPublishableSuggestedFixSelection({
    side: range.side,
    kind: range.kind,
    rangeStartLine: range.startLine,
    startLine: finding.startLine,
    endLine: finding.endLine,
    preview: range.preview,
    suggestedFix: finding.suggestedFix,
  });
}

function hasExpectedOutput(
  output: PiprEvalOutput,
  expected: PiprEvalExpected | undefined,
): expected is PiprEvalExpected {
  return output.ok && Boolean(expected);
}

export function expectedFindingMatches(
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
  const keywordSets = finding.keywordSets ?? [finding.keywords];
  return keywordSets.some((keywords) =>
    keywords.every((keyword) => normalizedBody.includes(keyword.toLowerCase())),
  );
}

function expectedFindingLocationMatches(
  finding: PiprEvalExpected["findings"][number],
  actual: EvalInlineFinding,
): boolean {
  return [
    actual.path === finding.path,
    finding.line >= actual.startLine,
    finding.line <= actual.endLine,
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
