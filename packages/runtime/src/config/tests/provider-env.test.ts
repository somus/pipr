import { describe, expect, it } from "bun:test";
import { providerEnvironment } from "../provider-env.js";

describe("providerEnvironment", () => {
  it("reads the standard API key variable from Pi's built-in providers", async () => {
    expect(await providerEnvironment("deepseek")).toEqual({
      apiKeyEnv: "DEEPSEEK_API_KEY",
      companions: [],
      alternatives: [],
    });
    expect((await providerEnvironment("anthropic"))?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect((await providerEnvironment("google"))?.apiKeyEnv).toBe("GEMINI_API_KEY");
  });

  it("keeps the variables a provider reads alongside its key", async () => {
    expect(await providerEnvironment("cloudflare-ai-gateway")).toEqual({
      apiKeyEnv: "CLOUDFLARE_API_KEY",
      companions: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
      alternatives: [],
    });
  });

  it("lists fallback credential sources and the AWS SDK variables Bedrock needs", async () => {
    const bedrock = await providerEnvironment("amazon-bedrock");
    expect(bedrock?.apiKeyEnv).toBe("AWS_BEARER_TOKEN_BEDROCK");
    expect(bedrock?.alternatives).toContain("AWS_ACCESS_KEY_ID");
    expect(bedrock?.companions).toEqual(
      expect.arrayContaining(["AWS_SECRET_ACCESS_KEY", "AWS_REGION"]),
    );
    expect((await providerEnvironment("google-vertex"))?.alternatives).toEqual(
      expect.arrayContaining(["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"]),
    );
  });

  it("returns undefined for OAuth-only and unknown providers", async () => {
    expect(await providerEnvironment("openai-codex")).toBeUndefined();
    expect(await providerEnvironment("not-a-provider")).toBeUndefined();
  });
});
