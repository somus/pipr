import { describe, expect, it } from "bun:test";
import { parsePiProviderProfile } from "../contract.js";

describe("Pi provider profile", () => {
  it("accepts only Pi-native provider profile fields", () => {
    expect(
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "high",
      }),
    ).toMatchObject({ thinking: "high" });
    expect(() =>
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        options: { reasoning_effort: "high" },
      }),
    ).toThrow();
    expect(() =>
      parsePiProviderProfile({
        id: "deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        thinking: "enabled",
      }),
    ).toThrow();
  });
});
