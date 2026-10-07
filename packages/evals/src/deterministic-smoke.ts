#!/usr/bin/env bun

import { promptEvalCasesForMode } from "./cases.js";
import { runPiprEvalCase } from "./runner.js";
import { scorePiprEvalOutput } from "./scoring.js";

const deterministicCases = promptEvalCasesForMode("deterministic");
assert(deterministicCases.length > 0, "missing deterministic prompt eval cases");

for (const testCase of deterministicCases) {
  const output = await runPiprEvalCase(testCase, { mode: "deterministic" });
  assert(output.ok, `${testCase.id}: ${output.error ?? "review failed"}`);
  if (testCase.reviewer === "custom") {
    assert(
      output.piCalls.some((call) => call.customReviewSchema === true),
      `${testCase.id}: custom review schema was not exercised`,
    );
  }

  for (const score of scorePiprEvalOutput(output, testCase.expected, {
    includePromptPolicy: true,
  })) {
    assert(score.score === 1, `${testCase.id}: ${score.name} scored ${score.score}`);
  }
}

console.log("prompt eval smoke tests ok");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}
