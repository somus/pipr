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
        AWS_REGION: "us-east-1",
        CI_PROJECT_ID: "12345",
        SYSTEM_TEAMPROJECTID: "project-guid",
      }),
    ).toEqual(["secret-password", "secret-key"]);
  });

  it.each([
    "GITHUB_TOKEN",
    "GITLAB_TOKEN",
    "CI_JOB_TOKEN",
    "BITBUCKET_TOKEN",
    "BITBUCKET_API_TOKEN",
    "BITBUCKET_PERMISSION_TOKEN",
    "BITBUCKET_PERMISSION_API_TOKEN",
    "AZURE_DEVOPS_TOKEN",
    "AZURE_DEVOPS_BEARER_TOKEN",
    "SYSTEM_ACCESSTOKEN",
    "GITEA_TOKEN",
    "FORGEJO_TOKEN",
    "CODEBERG_TOKEN",
    "PIPR_WEBHOOK_SECRET",
    "PIPR_R2_MEMORY_SECRET_ACCESS_KEY",
  ])("treats code host credential %s as sensitive", (name) => {
    expect(sensitiveEnvironmentValues({ [name]: "abcdefgh12345" })).toEqual(["abcdefgh12345"]);
  });
});

describe("createKnownSecretRedactor", () => {
  it("masks registered values without scanning unknown credential-like content", () => {
    const redactor = createKnownSecretRedactor({ env: {} });
    redactor.addSecret("registered-value");

    const result = redactor.redact(
      "Known registered-value, model-api_key-abcdefghijklmnop and github_token_abcdefghijklmnop.",
    );

    expect(result).toEqual({
      value:
        "Known [redacted secret], model-api_key-abcdefghijklmnop and github_token_abcdefghijklmnop.",
      detected: true,
    });
  });

  it("masks the Azure DevOps pipeline access token", () => {
    const redactor = createKnownSecretRedactor({ env: { SYSTEM_ACCESSTOKEN: "abcdefgh12345" } });

    expect(redactor.redact("Bearer abcdefgh12345").detected).toBe(true);
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
