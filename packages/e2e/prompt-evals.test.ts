#!/usr/bin/env bun
import { expect } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  promptEvalCasesForMode,
  runPiprEvalCase,
  runVerifierEvalCase,
  scorePiprEvalOutput,
  scoreVerifierEvalOutput,
  verifierEvalCases,
} from "@pipr/evals/internal";

const fakePiPath = fileURLToPath(new URL("./fake-pi", import.meta.url));

for (const testCase of promptEvalCasesForMode("deterministic")) {
  const output = await runPiprEvalCase(testCase, {
    mode: "deterministic",
    piExecutable: fakePiPath,
  });
  expect(output.ok, `${testCase.id}: ${output.error ?? "review failed"}`).toBe(true);

  for (const score of scorePiprEvalOutput(output, testCase.expected, {
    includePromptPolicy: true,
  })) {
    expect(score.score, `${testCase.id}: ${score.name}`).toBe(1);
  }
}

for (const testCase of verifierEvalCases) {
  const output = await runVerifierEvalCase(testCase);
  expect(output.ok, `${testCase.id}: ${output.error ?? "verifier failed"}`).toBe(true);

  for (const score of scoreVerifierEvalOutput(output, testCase.expected)) {
    expect(score.score, `${testCase.id}: ${score.name}`).toBe(1);
  }
}

console.log("prompt and verifier eval smoke tests ok");
