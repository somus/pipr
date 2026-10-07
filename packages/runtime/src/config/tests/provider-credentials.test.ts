import { describe, expect, it } from "bun:test";
import type { ProviderConfig } from "../../types.js";
import { missingProviderCredential, providerSecretEnvNames } from "../provider-credentials.js";
import { providerEnvironment } from "../provider-env.js";

async function bedrockProvider(): Promise<ProviderConfig> {
  const environment = await providerEnvironment("amazon-bedrock");
  if (!environment) throw new Error("expected a Bedrock provider environment");
  return {
    id: "bedrock",
    provider: "amazon-bedrock",
    model: "claude",
    apiKeyEnv: environment.apiKeyEnv,
    providerEnv: environment.companions,
    credentialEnv: environment.alternatives,
  };
}

describe("missingProviderCredential", () => {
  it("accepts fallback credentials and treats empty values as missing", async () => {
    const provider = await bedrockProvider();

    expect(
      missingProviderCredential(provider, {
        AWS_ACCESS_KEY_ID: "id",
        AWS_SECRET_ACCESS_KEY: "secret",
      }),
    ).toBeUndefined();
    expect(missingProviderCredential(provider, { AWS_ACCESS_KEY_ID: "" })).toBe(
      "AWS_BEARER_TOKEN_BEDROCK",
    );
  });
});

describe("providerSecretEnvNames", () => {
  it("redacts Bedrock key material but not regions", async () => {
    const names = providerSecretEnvNames(await bedrockProvider());

    expect(names).toEqual(
      expect.arrayContaining([
        "AWS_BEARER_TOKEN_BEDROCK",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
      ]),
    );
    expect(names).not.toContain("AWS_REGION");
    expect(names).not.toContain("AWS_DEFAULT_REGION");
  });

  it("redacts a custom-named apiKey", () => {
    expect(
      providerSecretEnvNames({ id: "custom", provider: "deepseek", model: "m", apiKeyEnv: "FOO" }),
    ).toEqual(["FOO"]);
  });
});
