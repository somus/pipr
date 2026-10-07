import { describe, expect, it } from "bun:test";
import { definePipr, z } from "../index.js";
import type { RuntimePlan } from "../internal.js";
import { buildPiprPlan, facetsForFindingSchema } from "../internal.js";

function capture<T>(configure: (pipr: Parameters<Parameters<typeof definePipr>[0]>[0]) => T): {
  value: T;
  plan: RuntimePlan;
} {
  let value: T | undefined;
  const plan = buildPiprPlan(
    definePipr((pipr) => {
      value = configure(pipr);
      pipr.model("deepseek/deepseek-v4-pro");
    }),
  );
  return { value: value as T, plan };
}

describe("pipr.finding", () => {
  it("extends the core finding with declared fields and records enum facets in order", () => {
    const { value: Finding } = capture((pipr) =>
      pipr.finding({
        severity: z.enum(["critical", "high", "low"]),
        category: z.enum(["bug", "security"]).optional(),
        title: z.string(),
      }),
    );
    const parsed = Finding.parse({
      body: "Bug",
      path: "src/a.ts",
      rangeId: "rng_1",
      side: "RIGHT",
      startLine: 1,
      endLine: 1,
      severity: "high",
      title: "Title",
    });
    expect(parsed.severity).toBe("high");
    expect(facetsForFindingSchema(Finding)).toEqual({
      severity: ["critical", "high", "low"],
      category: ["bug", "security"],
    });
  });

  it("rejects redeclared core fields", () => {
    expect(() => capture((pipr) => pipr.finding({ path: z.string() }))).toThrow(
      "pipr.finding field 'path' is a core finding field",
    );
  });

  it("accepts a raw Zod schema as agent output", () => {
    const { plan } = capture((pipr) =>
      pipr.agent({
        name: "reviewer",
        instructions: "Review.",
        output: z.strictObject({ inlineFindings: z.array(pipr.finding({})) }),
        prompt: () => "Review.",
      }),
    );
    const output = plan.agents[0]?.definition.output;
    expect(output?.id).toBe("agent/reviewer");
    expect(output?.safeParse({ inlineFindings: [] }).success).toBe(true);
  });
});

describe("pipr.model", () => {
  it("parses provider/model references and keeps slashes in model ids", () => {
    const { value, plan } = capture((pipr) => [
      pipr.model("openrouter/anthropic/claude-sonnet", { thinking: "high" }),
      pipr.model("openai-codex/gpt-5.5", { apiKey: "local" }),
    ]);
    expect(plan.models.map((model) => model.id)).toEqual([
      "openrouter/anthropic/claude-sonnet",
      "openai-codex/gpt-5.5",
      "deepseek/deepseek-v4-pro",
    ]);
    expect(value[0]).toMatchObject({
      id: "openrouter/anthropic/claude-sonnet",
      provider: "openrouter",
      model: "anthropic/claude-sonnet",
      thinking: "high",
    });
    expect(value[0]?.apiKey).toBeUndefined();
    expect(value[1]?.apiKey).toBe("local");
  });

  it("rejects references without a provider", () => {
    expect(() => capture((pipr) => pipr.model("gpt-5" as `${string}/${string}`))).toThrow(
      "pipr.model requires a 'provider/model' reference",
    );
  });
});
