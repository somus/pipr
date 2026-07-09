import { evalite } from "evalite";
import {
  assertLiveEvalEnv,
  cleanSuppressionGateScorers,
  defectRecallGateScorers,
  livePromptEvalCases,
  livePromptGateCaseIds,
  runLivePiprEvalCase,
  safetyHygieneGateScorers,
  suggestedFixGateScorers,
} from "./live-prompt-gates.js";

assertLiveEvalEnv();

evalite("Pipr suggested-fix live prompt gate", {
  data: livePromptEvalCases(livePromptGateCaseIds.suggestedFix, "suggested-fix").map(
    (testCase) => ({
      input: testCase,
      expected: testCase.expected,
    }),
  ),
  task: runLivePiprEvalCase,
  scorers: suggestedFixGateScorers,
});

evalite("Pipr defect recall live prompt gate", {
  data: livePromptEvalCases(livePromptGateCaseIds.defectRecall, "defect-recall").map(
    (testCase) => ({
      input: testCase,
      expected: testCase.expected,
    }),
  ),
  task: runLivePiprEvalCase,
  scorers: defectRecallGateScorers,
});

evalite("Pipr clean suppression live prompt gate", {
  data: livePromptEvalCases(livePromptGateCaseIds.cleanSuppression, "clean-suppression").map(
    (testCase) => ({
      input: testCase,
      expected: testCase.expected,
    }),
  ),
  task: runLivePiprEvalCase,
  scorers: cleanSuppressionGateScorers,
});

evalite("Pipr safety hygiene live prompt gate", {
  data: livePromptEvalCases(livePromptGateCaseIds.safetyHygiene, "safety-hygiene").map(
    (testCase) => ({
      input: testCase,
      expected: testCase.expected,
    }),
  ),
  task: runLivePiprEvalCase,
  scorers: safetyHygieneGateScorers,
});
