import { evalite } from "evalite";
import { promptEvalCasesForMode } from "./cases.js";
import {
  assertLiveEvalEnv,
  fullAdvisoryScorers,
  runLivePiprEvalCase,
} from "./live-prompt-gates.js";

assertLiveEvalEnv();

evalite("Pipr full live review prompt advisory", {
  data: promptEvalCasesForMode("live").map((testCase) => ({
    input: testCase,
    expected: testCase.expected,
  })),
  task: runLivePiprEvalCase,
  scorers: fullAdvisoryScorers,
});
