import { evalite } from "evalite";
import {
  assertLiveEvalEnv,
  livePromptEvalCases,
  livePromptGateCaseIds,
  runLivePiprEvalCase,
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
