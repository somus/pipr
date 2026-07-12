import { describe, expect, it } from "bun:test";
import { createHostRunAdapter } from "../adapter.js";

describe("host-run adapter selection", () => {
  it("registers GitLab for explicit and native CI selection", () => {
    expect(createHostRunAdapter({ host: "gitlab", env: { GITLAB_TOKEN: "test-token" } }).id).toBe(
      "gitlab",
    );
    expect(
      createHostRunAdapter({ env: { GITLAB_CI: "true", GITLAB_TOKEN: "test-token" } }).id,
    ).toBe("gitlab");
  });

  it("fails GitLab selection before execution when credentials are missing", () => {
    expect(() => createHostRunAdapter({ host: "gitlab", env: {} })).toThrow(
      "GITLAB_TOKEN or CI_JOB_TOKEN is required",
    );
  });

  it("registers Azure DevOps for explicit and native pipeline selection", () => {
    const env = {
      AZURE_DEVOPS_TOKEN: "test-token",
      AZURE_DEVOPS_ORGANIZATION: "org",
      AZURE_DEVOPS_PROJECT: "project",
    };
    expect(createHostRunAdapter({ host: "azure-devops", env }).id).toBe("azure-devops");
    expect(createHostRunAdapter({ env: { ...env, TF_BUILD: "True" } }).id).toBe("azure-devops");
  });

  it("fails Azure DevOps selection before execution when coordinates are missing", () => {
    expect(() =>
      createHostRunAdapter({ host: "azure-devops", env: { AZURE_DEVOPS_TOKEN: "token" } }),
    ).toThrow("AZURE_DEVOPS_ORGANIZATION is required");
  });

  it("registers Bitbucket for explicit and native pipeline selection", () => {
    const env = {
      BITBUCKET_WORKSPACE: "workspace",
      BITBUCKET_REPO_SLUG: "repository",
      BITBUCKET_TOKEN: "token",
    };
    expect(createHostRunAdapter({ host: "bitbucket", env }).id).toBe("bitbucket");
    expect(createHostRunAdapter({ env: { ...env, BITBUCKET_BUILD_NUMBER: "1" } }).id).toBe(
      "bitbucket",
    );
  });
});
