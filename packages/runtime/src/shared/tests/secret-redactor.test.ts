import { describe, expect, it } from "bun:test";
import { createKnownSecretRedactor, sensitiveEnvironmentValues } from "../secret-redactor.js";

describe("sensitiveEnvironmentValues", () => {
  it("does not treat pass substrings in ordinary environment names as secrets", () => {
    expect(
      sensitiveEnvironmentValues({
        COMPASS_DIR: "/workspace/compass",
        BYPASS_PROXY: "localhost",
        DATABASE_PASSWORD: "secret-password",
      }),
    ).toEqual(["secret-password"]);
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
