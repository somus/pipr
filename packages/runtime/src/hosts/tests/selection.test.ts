import { describe, expect, it } from "bun:test";
import { resolveCodeHostId } from "../selection.js";

describe("code host selection", () => {
  it("prefers an explicit host over CI environment detection", () => {
    expect(
      resolveCodeHostId({
        explicitHost: "gitlab",
        env: { GITHUB_ACTIONS: "true" },
      }),
    ).toBe("gitlab");
  });

  it("prefers PIPR_CODE_HOST over CI environment detection", () => {
    expect(
      resolveCodeHostId({
        env: { PIPR_CODE_HOST: "azure-devops", GITHUB_ACTIONS: "true" },
      }),
    ).toBe("azure-devops");
  });

  it("detects each supported native CI environment", () => {
    expect(resolveCodeHostId({ env: { GITHUB_ACTIONS: "true" } })).toBe("github");
    expect(resolveCodeHostId({ env: { GITLAB_CI: "true" } })).toBe("gitlab");
    expect(resolveCodeHostId({ env: { TF_BUILD: "True" } })).toBe("azure-devops");
    expect(resolveCodeHostId({ env: { BITBUCKET_BUILD_NUMBER: "12" } })).toBe("bitbucket");
  });

  it("rejects ambiguous native CI environments", () => {
    expect(() => resolveCodeHostId({ env: { GITHUB_ACTIONS: "true", GITLAB_CI: "true" } })).toThrow(
      "Multiple code hosts detected: github, gitlab",
    );
  });

  it("rejects missing and unsupported hosts", () => {
    expect(() => resolveCodeHostId({ env: {} })).toThrow("A code host must be selected");
    expect(() => resolveCodeHostId({ explicitHost: "unknown-host", env: {} })).toThrow(
      "Unsupported code host 'unknown-host'",
    );
  });
});
