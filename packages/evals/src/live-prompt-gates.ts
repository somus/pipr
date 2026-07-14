import { type PiprEvalCase, type PiprEvalExpected, promptEvalCasesForMode } from "./cases.js";
import type { PiprEvalOutput } from "./runner.js";
import { runPiprEvalCase } from "./runner.js";
import {
  diagnoseExpectedFindingRecall,
  type ExpectedFindingRecallDiagnostics,
  scoreExpectedFindings,
  scoreExpectedInlineSelection,
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

type LivePromptGateDefinition = {
  name: string;
  label: string;
  caseIds: readonly string[];
  scorers: readonly LivePromptScorer[];
};

export type LivePromptGateFailure = {
  caseId: string;
  gate: string;
  failedScorers: string[];
  recall?: ExpectedFindingRecallDiagnostics;
};

export const livePromptGateCaseIds = {
  cleanSuppression: [
    "harmless-refactor",
    "out-of-scope-docs",
    "coordinated-cross-file-contract-clean",
  ],
  defectRecall: [
    "security-open-redirect",
    "empty-value-contract-regression",
    "minimal-inline-selection",
    "removed-await-effect-regression",
    "unchanged-caller-contract-regression",
  ],
  safetyHygiene: ["untrusted-schema-instruction-lure"],
  suggestedFix: [
    "correctness-null-regression",
    "suggested-fix-range-selection",
    "synthetic-secret-redaction",
  ],
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

const expectedInlineSelectionScorer = {
  name: "Expected inline selection",
  scorer: ({ output, expected }) => scoreExpectedInlineSelection(output, expected),
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

const cleanSuppressionGateScorers = [
  runSucceededScorer,
  falsePositiveSuppressionScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

const defectRecallGateScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  falsePositiveSuppressionScorer,
  validInlineAnchoringScorer,
  expectedInlineSelectionScorer,
  inlineFindingBodyBudgetScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export const fullAdvisoryScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  forbiddenOutputSuppressionScorer,
  falsePositiveSuppressionScorer,
  validInlineAnchoringScorer,
  expectedInlineSelectionScorer,
  inlineFindingBodyBudgetScorer,
  suggestedFixRangeShapeScorer,
  expectedSuggestedFixBehaviorScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

const safetyHygieneGateScorers = [
  runSucceededScorer,
  expectedFindingRecallScorer,
  forbiddenOutputSuppressionScorer,
  falsePositiveSuppressionScorer,
  findingCountBudgetScorer,
] satisfies LivePromptScorer[];

export const suggestedFixGateScorers = [
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

export const suggestedFixLivePromptGate = {
  name: "Pipr suggested-fix live prompt gate",
  label: "suggested-fix",
  caseIds: livePromptGateCaseIds.suggestedFix,
  scorers: suggestedFixGateScorers,
} satisfies LivePromptGateDefinition;

export const defectRecallLivePromptGate = {
  name: "Pipr defect recall live prompt gate",
  label: "defect-recall",
  caseIds: livePromptGateCaseIds.defectRecall,
  scorers: defectRecallGateScorers,
} satisfies LivePromptGateDefinition;

export const cleanSuppressionLivePromptGate = {
  name: "Pipr clean suppression live prompt gate",
  label: "clean-suppression",
  caseIds: livePromptGateCaseIds.cleanSuppression,
  scorers: cleanSuppressionGateScorers,
} satisfies LivePromptGateDefinition;

export const safetyHygieneLivePromptGate = {
  name: "Pipr safety hygiene live prompt gate",
  label: "safety-hygiene",
  caseIds: livePromptGateCaseIds.safetyHygiene,
  scorers: safetyHygieneGateScorers,
} satisfies LivePromptGateDefinition;

export function assertLiveEvalEnv(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for live prompt evals");
  }
}

function livePromptEvalCases(ids: readonly string[], label: string): PiprEvalCase[] {
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

export function livePromptGateFailure(
  gate: LivePromptGateDefinition,
  caseId: string,
  input: LivePromptScoreInput,
): LivePromptGateFailure | undefined {
  const failedScorers = gate.scorers
    .filter(({ scorer }) => scorer(input) !== 1)
    .map(({ name }) => name);
  return failedScorers.length > 0
    ? {
        caseId,
        gate: gate.label,
        failedScorers,
        ...(failedScorers.includes(expectedFindingRecallScorer.name)
          ? { recall: diagnoseExpectedFindingRecall(input.output, input.expected) }
          : {}),
      }
    : undefined;
}

export function livePromptGateEvalConfig(gate: LivePromptGateDefinition) {
  return {
    data: livePromptEvalCases(gate.caseIds, gate.label).map((testCase) => ({
      input: testCase,
      expected: testCase.expected,
    })),
    task: async (testCase: PiprEvalCase) => {
      const output = await runLivePiprEvalCase(testCase);
      const failure = livePromptGateFailure(gate, testCase.id, {
        output,
        expected: testCase.expected,
      });
      if (failure) {
        console.error(`[pipr eval] ${JSON.stringify(failure)}`);
      }
      return output;
    },
    scorers: [...gate.scorers],
  };
}
