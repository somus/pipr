import {
  isPublishableSuggestedFixSelection,
  maxInlineFindingBodyCharacters,
  maxInlineFindingBodyLines,
} from "@usepipr/runtime/internal/testing";
import type { PiprEvalExpected } from "./cases.js";
import type { EvalDiffRange, EvalInlineFinding, PiprEvalOutput } from "./runner.js";
import { piprEvalForbiddenOutputText } from "./runner.js";

export type PiprEvalScore = {
  name: string;
  score: number;
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
    { name: "Inline finding body budget", score: scoreInlineFindingBodyBudget(output) },
    { name: "Suggested fix range shape", score: scoreSuggestedFixRangeShape(output) },
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
        expected.findings.some((finding) => expectedFindingMatches(finding, actual)),
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
      finding.body.length <= maxInlineFindingBodyCharacters + 3 &&
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
    kind: "added",
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

function expectedFindingMatches(
  finding: PiprEvalExpected["findings"][number],
  actual: EvalInlineFinding,
): boolean {
  return [
    actual.path === finding.path,
    finding.line >= actual.startLine,
    finding.line <= actual.endLine,
    finding.keywords.every((keyword) => actual.body.toLowerCase().includes(keyword)),
  ].every(Boolean);
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
