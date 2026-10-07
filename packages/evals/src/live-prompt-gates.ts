import { type PiprEvalCase, promptEvalCasesForMode } from "./cases.js";
import type { PiprEvalOutput } from "./runner.js";
import { runPiprEvalCase } from "./runner.js";
import {
  diagnoseExpectedFindingRecall,
  type ExpectedFindingRecallDiagnostics,
  type PiprEvalScoreInput,
  type PiprEvalScorer,
  piprEvalScorers,
} from "./scoring.js";

type LivePromptGateDefinition = {
  name: string;
  label: string;
  caseIds: readonly string[];
  scorers: readonly PiprEvalScorer[];
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

const {
  runSucceeded,
  expectedFindingRecall,
  forbiddenOutputSuppression,
  falsePositiveSuppression,
  validInlineAnchoring,
  expectedInlineSelection,
  inlineFindingBodyBudget,
  suggestedFixRangeShape,
  expectedSuggestedFixBehavior,
  findingCountBudget,
} = piprEvalScorers;

const cleanSuppressionGateScorers = [
  runSucceeded,
  falsePositiveSuppression,
  findingCountBudget,
] satisfies PiprEvalScorer[];

const defectRecallGateScorers = [
  runSucceeded,
  expectedFindingRecall,
  falsePositiveSuppression,
  validInlineAnchoring,
  expectedInlineSelection,
  inlineFindingBodyBudget,
  findingCountBudget,
] satisfies PiprEvalScorer[];

export const fullAdvisoryScorers = [
  runSucceeded,
  expectedFindingRecall,
  forbiddenOutputSuppression,
  falsePositiveSuppression,
  validInlineAnchoring,
  expectedInlineSelection,
  inlineFindingBodyBudget,
  suggestedFixRangeShape,
  expectedSuggestedFixBehavior,
  findingCountBudget,
] satisfies PiprEvalScorer[];

const safetyHygieneGateScorers = [
  runSucceeded,
  expectedFindingRecall,
  forbiddenOutputSuppression,
  falsePositiveSuppression,
  findingCountBudget,
] satisfies PiprEvalScorer[];

export const suggestedFixGateScorers = [
  runSucceeded,
  expectedFindingRecall,
  forbiddenOutputSuppression,
  falsePositiveSuppression,
  validInlineAnchoring,
  inlineFindingBodyBudget,
  suggestedFixRangeShape,
  expectedSuggestedFixBehavior,
  findingCountBudget,
] satisfies PiprEvalScorer[];

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
  input: PiprEvalScoreInput,
): LivePromptGateFailure | undefined {
  const failedScorers = gate.scorers
    .filter(({ scorer }) => scorer(input) !== 1)
    .map(({ name }) => name);
  return failedScorers.length > 0
    ? {
        caseId,
        gate: gate.label,
        failedScorers,
        ...(failedScorers.includes(expectedFindingRecall.name)
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
