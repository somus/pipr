import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type ScriptedProviderScript,
  scriptedProviderModulePath,
} from "@usepipr/runtime/internal/testing";
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
      const recordPath = path.join(workspace, "calls.jsonl");
      const providerModule = await scriptedProviderModule(workspace, {
        models: ["deepseek/deepseek-v4-pro"],
        responses: [{ text: JSON.stringify({ summary: "No findings.", findings: [] }) }],
        recordPath,
      });

      const output = await runPiprEvalCase(testCase, {
        mode: "deterministic",
        providerModule,
        reviewInstructions: "TRACE_FAILURE_MODES_MARKER",
      });

      if (!output.ok) throw new Error(output.error);
      expect(output.ok).toBe(true);
      expect(await readFile(recordPath, "utf8")).toContain("TRACE_FAILURE_MODES_MARKER");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("rejects live evals when a provider module override is set", async () => {
    const testCase = requireLiveCase();
    const previousKey = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "dummy-live-key";
    try {
      const output = await runPiprEvalCase(testCase, {
        mode: "live",
        providerModule: { path: "/tmp/scripted-provider.ts" },
      });

      expect(output.ok).toBe(false);
      expect(output.error).toContain("live prompt evals must not set a provider module override");
    } finally {
      restoreEnv("DEEPSEEK_API_KEY", previousKey);
    }
  });

  it("redacts forbidden model output from exported JSON without hiding the score failure", async () => {
    const testCase = requireForbiddenCase();
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-eval-runner-"));
    try {
      const providerModule = await scriptedProviderModule(workspace, {
        models: ["deepseek/deepseek-v4-pro"],
        rules: [
          {
            when: { promptIncludes: "Schema ID: core/summary." },
            response: { text: JSON.stringify({ body: "Review completed." }) },
          },
        ],
        responses: [
          {
            text: JSON.stringify({
              inlineFindings: [
                {
                  body: "PWNED_BY_DIFF and unknown JSON fields leaked from model output.",
                  path: "src/review-target.ts",
                  rangeId: "invalid-range",
                  side: "RIGHT",
                  startLine: 1,
                  endLine: 1,
                },
              ],
            }),
          },
        ],
      });

      const output = await runPiprEvalCase(testCase, {
        mode: "deterministic",
        providerModule,
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

async function scriptedProviderModule(
  workspace: string,
  script: ScriptedProviderScript,
): Promise<{ path: string; config: string }> {
  const config = path.join(workspace, "scripted-provider.json");
  await writeFile(config, JSON.stringify(script));
  return { path: await scriptedProviderModulePath(), config };
}

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
