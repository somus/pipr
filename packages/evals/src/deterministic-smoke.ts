#!/usr/bin/env bun

import { fileURLToPath } from "node:url";
import { promptEvalCasesForMode } from "./cases.js";
import { runPiprEvalCase } from "./runner.js";
import { scorePiprEvalOutput } from "./scoring.js";

const fakePiPath = fileURLToPath(new URL("./fake-pi.ts", import.meta.url));
const deterministicCases = promptEvalCasesForMode("deterministic");
const fallbackCase = deterministicCases[0];

assert(fallbackCase, "missing deterministic prompt eval case");

const previousPiExecutable = process.env.PIPR_EVAL_PI_EXECUTABLE;
try {
  delete process.env.PIPR_EVAL_PI_EXECUTABLE;
  const packagedOutput = await runPiprEvalCase(fallbackCase, { mode: "deterministic" });
  assert(packagedOutput.ok, `${fallbackCase.id}: packaged fake Pi should run`);

  process.env.PIPR_EVAL_PI_EXECUTABLE = fakePiPath;
  const envOverrideOutput = await runPiprEvalCase(fallbackCase, { mode: "deterministic" });
  assert(envOverrideOutput.ok, `${fallbackCase.id}: fake Pi override should run`);
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
  assert(output.ok, `${testCase.id}: ${output.error ?? "review failed"}`);

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
