import { describe, expect, it } from "bun:test";
import { providerDefaultApiKeyEnv } from "../provider-env.js";

describe("providerDefaultApiKeyEnv", () => {
  it("reads the standard API key variable from Pi's built-in providers", async () => {
    expect(await providerDefaultApiKeyEnv("deepseek")).toBe("DEEPSEEK_API_KEY");
    expect(await providerDefaultApiKeyEnv("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(await providerDefaultApiKeyEnv("google")).toBe("GEMINI_API_KEY");
  });

  it("returns undefined for OAuth-only and unknown providers", async () => {
    expect(await providerDefaultApiKeyEnv("openai-codex")).toBeUndefined();
    expect(await providerDefaultApiKeyEnv("not-a-provider")).toBeUndefined();
  });
});
