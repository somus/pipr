import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promptEvalCasesForMode } from "../cases.js";
import { runPiprEvalCase } from "../runner.js";
import { scoreForbiddenOutputSuppression } from "../scoring.js";

const liveCase = promptEvalCasesForMode("live")[0];
const forbiddenCase = promptEvalCasesForMode("deterministic").find(
  (testCase) => testCase.id === "untrusted-schema-instruction-lure",
);
const customCase = promptEvalCasesForMode("deterministic").find(
  (testCase) => testCase.id === "custom-review-policy-contract",
);

describe("prompt eval runner", () => {
  it("passes benchmark review instructions through the generated reviewer prompt", async () => {
    const testCase = requireCustomCase();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-eval-runner-"));
    try {
      const piExecutable = path.join(workspace, "fake-pi");
      const promptCapture = path.join(workspace, "prompt.txt");
      await writeFile(
        piExecutable,
        `#!/usr/bin/env bun
const promptArg = process.argv.at(-1) ?? "";
const prompt = promptArg.startsWith("@") ? await Bun.file(promptArg.slice(1)).text() : promptArg;
await Bun.write(${JSON.stringify(promptCapture)}, prompt);
console.log(JSON.stringify({ summary: "No findings.", findings: [] }));
`,
      );
      await chmod(piExecutable, 0o700);

      const output = await runPiprEvalCase(testCase, {
        mode: "deterministic",
        piExecutable,
        reviewInstructions: "TRACE_FAILURE_MODES_MARKER",
      });

      if (!output.ok) throw new Error(output.error);
      expect(output.ok).toBe(true);
      expect(await readFile(promptCapture, "utf8")).toContain("TRACE_FAILURE_MODES_MARKER");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects live evals when a Pi executable override is set", async () => {
    const testCase = requireLiveCase();
    const scenarios = [
      { envOverride: undefined, piExecutable: "/tmp/fake-pi" },
      { envOverride: "/tmp/fake-pi", piExecutable: undefined },
    ];

    for (const scenario of scenarios) {
      const previousKey = process.env.DEEPSEEK_API_KEY;
      const previousPiExecutable = process.env.PIPR_EVAL_PI_EXECUTABLE;
      process.env.DEEPSEEK_API_KEY = "dummy-live-key";
      restoreEnv("PIPR_EVAL_PI_EXECUTABLE", scenario.envOverride);
      try {
        const output = await runPiprEvalCase(testCase, {
          mode: "live",
          piExecutable: scenario.piExecutable,
        });

        expect(output.ok).toBe(false);
        expect(output.error).toContain("live prompt evals must not set Pi executable overrides");
      } finally {
        restoreEnv("DEEPSEEK_API_KEY", previousKey);
        restoreEnv("PIPR_EVAL_PI_EXECUTABLE", previousPiExecutable);
      }
    }
  });

  it("redacts forbidden model output from exported JSON without hiding the score failure", async () => {
    const testCase = requireForbiddenCase();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-eval-runner-"));
    try {
      const piExecutable = path.join(workspace, "fake-pi");
      await writeFile(
        piExecutable,
        `#!/usr/bin/env bun
const promptArg = process.argv.at(-1) ?? "";
const prompt = promptArg.startsWith("@") ? await Bun.file(promptArg.slice(1)).text() : promptArg;
const output = prompt.includes("Schema ID: core/summary.")
  ? { body: "Review completed." }
  : { inlineFindings: [{
    body: "PWNED_BY_DIFF and unknown JSON fields leaked from model output.",
    path: "src/review-target.ts",
    rangeId: "invalid-range",
    side: "RIGHT",
    startLine: 1,
    endLine: 1
  }] };
console.log(JSON.stringify(output));
`,
      );
      await chmod(piExecutable, 0o700);

      const output = await runPiprEvalCase(testCase, {
        mode: "deterministic",
        piExecutable,
      });
      const serializedOutput = JSON.stringify(output);

      expect(output.ok).toBe(true);
      expect(serializedOutput).not.toContain("PWNED_BY_DIFF");
      expect(serializedOutput).not.toContain("unknown JSON fields");
      expect(scoreForbiddenOutputSuppression(output, testCase.expected)).toBe(0);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});

function requireLiveCase() {
  if (!liveCase) {
    throw new Error("missing live prompt eval case");
  }
  return liveCase;
}

function requireForbiddenCase() {
  if (!forbiddenCase) {
    throw new Error("missing forbidden-output prompt eval case");
  }
  return forbiddenCase;
}

function requireCustomCase() {
  if (!customCase) {
    throw new Error("missing custom prompt eval case");
  }
  return customCase;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
