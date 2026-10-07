import { evalite } from "evalite";
import { promptEvalCasesForMode } from "./cases.js";
import { assertLiveEvalEnv } from "./env.js";
import { fullAdvisoryScorers, runLivePiprEvalCase } from "./live-prompt-gates.js";

assertLiveEvalEnv();

evalite("Pipr full live review prompt advisory", {
  data: promptEvalCasesForMode("live").map((testCase) => ({
    input: testCase,
    expected: testCase.expected,
  })),
  task: runLivePiprEvalCase,
  scorers: fullAdvisoryScorers,
});
