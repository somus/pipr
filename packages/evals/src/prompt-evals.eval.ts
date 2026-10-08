import { evalite } from "evalite";
import { datasetEvalCases, promptEvalCasesForMode } from "./cases.js";
import { assertLiveEvalEnv } from "./env.js";
import { fullAdvisoryScorers, runLivePiprEvalCase } from "./live-prompt-gates.js";

assertLiveEvalEnv();

evalite("Pipr full live review prompt advisory", {
  // PIPR_EVAL_DATASET adds cases exported by `pipr runs export --dataset`.
  data: async () =>
    [
      ...promptEvalCasesForMode("live"),
      ...(process.env.PIPR_EVAL_DATASET
        ? await datasetEvalCases(process.env.PIPR_EVAL_DATASET)
        : []),
    ].map((testCase) => ({ input: testCase, expected: testCase.expected })),
  task: runLivePiprEvalCase,
  scorers: fullAdvisoryScorers,
});
