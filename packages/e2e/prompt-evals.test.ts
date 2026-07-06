#!/usr/bin/env bun
import { expect } from "bun:test";
import { fileURLToPath } from "node:url";
import { promptEvalCasesForMode, runPiprEvalCase, scorePiprEvalOutput } from "@pipr/evals/internal";

const fakePiPath = fileURLToPath(new URL("./fake-pi", import.meta.url));
const deterministicCases = promptEvalCasesForMode("deterministic");
const fallbackCase = deterministicCases[0];

if (!fallbackCase) {
  throw new Error("missing deterministic prompt eval case");
}

const previousPiExecutable = process.env.PIPR_EVAL_PI_EXECUTABLE;
try {
  delete process.env.PIPR_EVAL_PI_EXECUTABLE;
  const missingExecutableOutput = await runPiprEvalCase(fallbackCase, { mode: "deterministic" });
  expect(missingExecutableOutput.ok, `${fallbackCase.id}: missing fake Pi should fail`).toBe(false);
  expect(missingExecutableOutput.error).toContain(
    "deterministic prompt evals require a fake Pi executable",
  );

  process.env.PIPR_EVAL_PI_EXECUTABLE = fakePiPath;
  const fallbackOutput = await runPiprEvalCase(fallbackCase, { mode: "deterministic" });
  expect(fallbackOutput.ok, `${fallbackCase.id}: ${fallbackOutput.error ?? "review failed"}`).toBe(
    true,
  );
} finally {
  if (previousPiExecutable === undefined) {
    delete process.env.PIPR_EVAL_PI_EXECUTABLE;
  } else {
    process.env.PIPR_EVAL_PI_EXECUTABLE = previousPiExecutable;
  }
}

for (const testCase of deterministicCases) {
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

console.log("prompt eval smoke tests ok");
