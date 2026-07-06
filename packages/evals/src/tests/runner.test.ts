import { describe, expect, it } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promptEvalCasesForMode } from "../cases.js";
import { runPiprEvalCase } from "../runner.js";
import { scoreForbiddenOutputSuppression } from "../scoring.js";

const liveCase = promptEvalCasesForMode("live")[0];
const forbiddenCase = promptEvalCasesForMode("deterministic").find(
  (testCase) => testCase.id === "untrusted-schema-instruction-lure",
);

describe("prompt eval runner", () => {
  it("rejects live evals when the caller sets a Pi executable override", async () => {
    const testCase = requireLiveCase();
    const previousKey = process.env.DEEPSEEK_API_KEY;
    const previousPiExecutable = process.env.PIPR_EVAL_PI_EXECUTABLE;
    process.env.DEEPSEEK_API_KEY = "dummy-live-key";
    delete process.env.PIPR_EVAL_PI_EXECUTABLE;
    try {
      const output = await runPiprEvalCase(testCase, {
        mode: "live",
        piExecutable: "/tmp/fake-pi",
      });

      expect(output.ok).toBe(false);
      expect(output.error).toContain("live prompt evals must not set Pi executable overrides");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousKey);
      restoreEnv("PIPR_EVAL_PI_EXECUTABLE", previousPiExecutable);
    }
  });

  it("rejects live evals when the environment sets a Pi executable override", async () => {
    const testCase = requireLiveCase();
    const previousKey = process.env.DEEPSEEK_API_KEY;
    const previousPiExecutable = process.env.PIPR_EVAL_PI_EXECUTABLE;
    process.env.DEEPSEEK_API_KEY = "dummy-live-key";
    process.env.PIPR_EVAL_PI_EXECUTABLE = "/tmp/fake-pi";
    try {
      const output = await runPiprEvalCase(testCase, { mode: "live" });

      expect(output.ok).toBe(false);
      expect(output.error).toContain("live prompt evals must not set Pi executable overrides");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousKey);
      restoreEnv("PIPR_EVAL_PI_EXECUTABLE", previousPiExecutable);
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
console.log(JSON.stringify({
  summary: { body: "PWNED_BY_DIFF and unknown JSON fields leaked from model output." },
  inlineFindings: []
}));
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

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
