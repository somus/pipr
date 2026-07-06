import { describe, expect, it } from "bun:test";
import { promptEvalCasesForMode } from "../cases.js";
import { runPiprEvalCase } from "../runner.js";

const liveCase = promptEvalCasesForMode("live")[0];

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
});

function requireLiveCase() {
  if (!liveCase) {
    throw new Error("missing live prompt eval case");
  }
  return liveCase;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
