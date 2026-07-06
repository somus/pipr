import { evalite } from "evalite";
import { promptEvalCasesForMode } from "./cases.js";
import { runPiprEvalCase } from "./runner.js";
import {
  scoreExpectedFindings,
  scoreFalsePositiveSuppression,
  scoreFindingCountBudget,
  scoreForbiddenOutputSuppression,
  scoreInlineFindingBodyBudget,
  scoreSuggestedFixRangeShape,
  scoreValidAnchoring,
} from "./scoring.js";

assertLiveEvalEnv();

evalite("Pipr live review prompt fixtures", {
  data: promptEvalCasesForMode("live").map((testCase) => ({
    input: testCase,
    expected: testCase.expected,
  })),
  task: async (testCase) => await runPiprEvalCase(testCase, { mode: "live" }),
  scorers: [
    {
      name: "Run succeeded",
      scorer: ({ output }) => (output.ok ? 1 : 0),
    },
    {
      name: "Expected finding recall",
      scorer: ({ output, expected }) => scoreExpectedFindings(output, expected),
    },
    {
      name: "Forbidden output suppression",
      scorer: ({ output, expected }) => scoreForbiddenOutputSuppression(output, expected),
    },
    {
      name: "False-positive suppression",
      scorer: ({ output, expected }) => scoreFalsePositiveSuppression(output, expected),
    },
    {
      name: "Valid inline anchoring",
      scorer: ({ output }) => scoreValidAnchoring(output),
    },
    {
      name: "Inline finding body budget",
      scorer: ({ output }) => scoreInlineFindingBodyBudget(output),
    },
    {
      name: "Suggested fix range shape",
      scorer: ({ output }) => scoreSuggestedFixRangeShape(output),
    },
    {
      name: "Finding count budget",
      scorer: ({ output, expected }) => scoreFindingCountBudget(output, expected),
    },
  ],
});

function assertLiveEvalEnv(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("DEEPSEEK_API_KEY is required for live prompt evals");
  }
}
