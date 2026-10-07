import { describe, expect, it } from "bun:test";
import { piProviderProfileSchema } from "../contract.js";

describe("Pi provider profile", () => {
  it("accepts only Pi-native provider profile fields", () => {
    expect(
      piProviderProfileSchema.parse({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
      }),
    ).toMatchObject({ thinking: "high" });
    expect(() =>
      piProviderProfileSchema.parse({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        options: { reasoning_effort: "high" },
      }),
    ).toThrow();
    expect(() =>
      piProviderProfileSchema.parse({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "enabled",
      }),
    ).toThrow();
  });
});
