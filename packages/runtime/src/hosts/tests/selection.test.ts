import { describe, expect, it } from "bun:test";
import {
  isCodeHostId,
  parseWebhookHostId,
  resolveCodeHostId,
  webhookHostIds,
} from "../selection.js";

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
    expect(resolveCodeHostId({ env: { GITEA_ACTIONS: "true" } })).toBe("gitea");
    expect(
      resolveCodeHostId({
        env: { FORGEJO_ACTIONS: "true", FORGEJO_SERVER_URL: "https://forge.example.com" },
      }),
    ).toBe("forgejo");
    expect(
      resolveCodeHostId({
        env: { FORGEJO_ACTIONS: "true", FORGEJO_SERVER_URL: "https://codeberg.org" },
      }),
    ).toBe("codeberg");
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

  it("recognizes code host ids", () => {
    expect(isCodeHostId("azure-devops")).toBe(true);
    expect(isCodeHostId("local")).toBe(false);
  });

  it("accepts webhook hosts and lists them when rejecting others", () => {
    expect(webhookHostIds.map((host) => parseWebhookHostId(host))).toEqual([...webhookHostIds]);
    for (const value of ["github", undefined]) {
      expect(() => parseWebhookHostId(value)).toThrow(
        "webhook serve supports --host gitlab, azure-devops, bitbucket, gitea, forgejo, or codeberg",
      );
    }
  });
});
