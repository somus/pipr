import { type PiprEvalCase, type PiprEvalExpected, promptEvalCasesForMode } from "./cases.js";
import type { PiprEvalOutput } from "./runner.js";
import { runPiprEvalCase } from "./runner.js";
import {
  scoreExpectedFindings,
  scoreExpectedSuggestedFixBehavior,
  scoreFalsePositiveSuppression,
  scoreFindingCountBudget,
  scoreForbiddenOutputSuppression,
  scoreInlineFindingBodyBudget,
  scoreSuggestedFixRangeShape,
  scoreValidAnchoring,
} from "./scoring.js";

type LivePromptScoreInput = {
  output: PiprEvalOutput;
  expected?: PiprEvalExpected;
};

type LivePromptScorer = {
  name: string;
  scorer: (input: LivePromptScoreInput) => number;
};

export const livePromptGateCaseIds = {
  cleanSuppression: ["harmless-refactor", "out-of-scope-docs"],
  defectRecall: ["security-open-redirect", "suggested-fix-range-selection"],
  safetyHygiene: ["untrusted-schema-instruction-lure"],
  suggestedFix: ["correctness-null-regression", "synthetic-secret-redaction"],
} as const;

const runSucceededScorer = {
  name: "Run succeeded",
  scorer: ({ output }) => (output.ok ? 1 : 0),
} satisfies LivePromptScorer;

const expectedFindingRecallScorer = {
  name: "Expected finding recall",
  scorer: ({ output, expected }) => scoreExpectedFindings(output, expected),
} satisfies LivePromptScorer;

const forbiddenOutputSuppressionScorer = {
  name: "Forbidden output suppression",
  scorer: ({ output, expected }) => scoreForbiddenOutputSuppression(output, expected),
} satisfies LivePromptScorer;

const falsePositiveSuppressionScorer = {
  name: "False-positive suppression",
  scorer: ({ output, expected }) => scoreFalsePositiveSuppression(output, expected),
} satisfies LivePromptScorer;

const validInlineAnchoringScorer = {
  name: "Valid inline anchoring",
  scorer: ({ output }) => scoreValidAnchoring(output),
} satisfies LivePromptScorer;

const inlineFindingBodyBudgetScorer = {
  name: "Inline finding body budget",
  scorer: ({ output }) => scoreInlineFindingBodyBudget(output),
} satisfies LivePromptScorer;

const suggestedFixRangeShapeScorer = {
  name: "Suggested fix range shape",
  scorer: ({ output }) => scoreSuggestedFixRangeShape(output),
} satisfies LivePromptScorer;

const expectedSuggestedFixBehaviorScorer = {
  name: "Expected suggested fix behavior",
  scorer: ({ output, expected }) => scoreExpectedSuggestedFixBehavior(output, expected),
} satisfies LivePromptScorer;

const findingCountBudgetScorer = {
  name: "Finding count budget",
  scorer: ({ output, expected }) => scoreFindingCountBudget(output, expected),
} satisfies LivePromptScorer;

export const cleanSuppressionGateScorers = [
  runSucceededScorer,
  falsePositiveSuppressionScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export const defectRecallGateScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  falsePositiveSuppressionScorer,
  validInlineAnchoringScorer,
  inlineFindingBodyBudgetScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export const fullAdvisoryScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  forbiddenOutputSuppressionScorer,
  falsePositiveSuppressionScorer,
  validInlineAnchoringScorer,
  inlineFindingBodyBudgetScorer,
  suggestedFixRangeShapeScorer,
  expectedSuggestedFixBehaviorScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export const safetyHygieneGateScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  forbiddenOutputSuppressionScorer,
  falsePositiveSuppressionScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export const suggestedFixGateScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  falsePositiveSuppressionScorer,
  validInlineAnchoringScorer,
  inlineFindingBodyBudgetScorer,
  suggestedFixRangeShapeScorer,
  expectedSuggestedFixBehaviorScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export function assertLiveEvalEnv(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for live prompt evals");
  }
}

export function livePromptEvalCases(ids: readonly string[], label: string): PiprEvalCase[] {
  const idSet = new Set(ids);
  const cases = promptEvalCasesForMode("live").filter((testCase) => idSet.has(testCase.id));
  if (cases.length !== idSet.size) {
    throw new Error(`${label} live prompt eval cases are incomplete`);
  }
  return cases;
}

export async function runLivePiprEvalCase(testCase: PiprEvalCase): Promise<PiprEvalOutput> {
  return await runPiprEvalCase(testCase, { mode: "live" });
}
