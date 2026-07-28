import { describe, expect, it } from "bun:test";
import {
  classifyProviderFailure,
  preferredProviderFailureRemediation,
} from "../provider-failure.js";

describe("provider failure remediation", () => {
  it("classifies exhausted billing before authentication status codes", () => {
    expect(
      classifyProviderFailure({
        provider: {
          id: "anthropic",
          provider: "anthropic",
          model: "claude-sonnet",
          apiKeyEnv: "ANTHROPIC_API_KEY",
        },
        output: "API Error 401: Your credit balance is too low to access the Anthropic API.",
      }),
    ).toEqual({
      category: "billing-quota",
      reason: "anthropic rejected the run because billing or quota is exhausted.",
      nextStep: "Restore credit or quota in the anthropic account, then rerun.",
    });
  });

  it("keeps classifier precedence when multiple provider attempts fail", () => {
    const transient = {
      category: "provider-unavailable" as const,
      reason: "provider unavailable",
      nextStep: "rerun",
    };
    const billing = {
      category: "billing-quota" as const,
      reason: "billing unavailable",
      nextStep: "restore quota",
    };

    expect(preferredProviderFailureRemediation(transient, billing)).toBe(billing);
    expect(preferredProviderFailureRemediation(billing, transient)).toBe(billing);
  });

  it("gives authentication guidance for the configured credential mode", () => {
    const provider = {
      id: "openai",
      provider: "openai",
      model: "gpt-5",
    };
    expect(
      classifyProviderFailure({
        provider: { ...provider, apiKeyEnv: "OPENAI_API_KEY" },
        output: "401 invalid API key",
      }),
    ).toMatchObject({
      category: "authentication",
      nextStep:
        "Verify the configured OPENAI_API_KEY secret or environment variable and openai account access, then rerun.",
    });
    expect(
      classifyProviderFailure({
        provider,
        output: "OAuth token expired",
      }),
    ).toMatchObject({
      category: "authentication",
      nextStep: "Refresh the stored openai subscription session credential, then rerun.",
    });
  });

  it("classifies actionable transient and model failures without echoing provider output", () => {
    const provider = {
      id: "gateway",
      provider: "gateway",
      model: "configured-model",
    };
    const cases = [
      {
        output: "429 rate limit exceeded: private-response-detail",
        category: "rate-limit",
        reason: "gateway rate limit was reached.",
      },
      {
        output: "ProviderModelNotFoundError: private-response-detail",
        category: "model-unavailable",
        reason: "The configured gateway model is unavailable.",
      },
      {
        output: "503 service unavailable: private-response-detail",
        category: "provider-unavailable",
        reason: "gateway is temporarily unavailable.",
      },
    ] as const;

    for (const expected of cases) {
      const remediation = classifyProviderFailure({ provider, output: expected.output });
      expect(remediation).toMatchObject({
        category: expected.category,
        reason: expected.reason,
      });
      expect(JSON.stringify(remediation)).not.toContain("private-response-detail");
    }
    expect(
      classifyProviderFailure({ provider, output: "unexpected process exit" }),
    ).toBeUndefined();
  });

  it("requires provider error context for bare HTTP status numbers", () => {
    const provider = {
      id: "gateway",
      provider: "gateway",
      model: "configured-model",
    };

    for (const output of [
      '{"path":"src/example.ts","endLine":503}',
      "process exited while reviewing line 429",
      "assertStatus(401)",
    ]) {
      expect(classifyProviderFailure({ provider, output })).toBeUndefined();
    }
    expect(classifyProviderFailure({ provider, output: "HTTP status 503" })).toMatchObject({
      category: "provider-unavailable",
    });
    expect(classifyProviderFailure({ provider, output: "API error 429" })).toMatchObject({
      category: "rate-limit",
    });
  });
});
