import { describe, expect, it } from "bun:test";
import { sensitiveEnvironmentValues } from "../secret-redaction.js";
import { createKnownSecretRedactor } from "../secret-redactor.js";

describe("sensitiveEnvironmentValues", () => {
  it("matches credential name segments without matching ordinary substrings", () => {
    expect(
      sensitiveEnvironmentValues({
        COMPASS_DIR: "/workspace/compass",
        BYPASS_PROXY: "localhost",
        TURKEY_MODE: "enabled",
        MONKEY_PATCH: "disabled",
        DATABASE_PASSWORD: "secret-password",
        PROVIDER_API_KEY: "secret-key",
      }),
    ).toEqual(["secret-password", "secret-key"]);
  });
});

describe("createKnownSecretRedactor", () => {
  it("masks registered values without scanning unknown credential-like content", () => {
    const redactor = createKnownSecretRedactor({ env: {} });
    redactor.addSecret("registered-value");

    const result = redactor.redact("Known registered-value and model-api_key-abcdefghijklmnop.");

    expect(result).toEqual({
      value: "Known [redacted secret] and model-api_key-abcdefghijklmnop.",
      detected: true,
    });
  });

  it("masks sensitive environment values exactly", () => {
    const redactor = createKnownSecretRedactor({
      env: { PROVIDER_TOKEN: "runtime-token" },
    });

    expect(redactor.redact("Use runtime-token here.")).toEqual({
      value: "Use [redacted secret] here.",
      detected: true,
    });
  });

  it("ignores short sensitive environment values", () => {
    const redactor = createKnownSecretRedactor({ env: { PROVIDER_TOKEN: "x" } });

    expect(redactor.redact("example text")).toEqual({
      value: "example text",
      detected: false,
    });
  });
});
