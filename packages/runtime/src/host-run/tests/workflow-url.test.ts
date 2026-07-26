import { describe, expect, it } from "bun:test";
import { workflowUrlFromEnvironment } from "../workflow-url.js";

describe("workflowUrlFromEnvironment", () => {
  it.each([
    [
      "github",
      {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
        GITHUB_RUN_ID: "123",
      },
      "https://github.com/acme/repo/actions/runs/123",
    ],
    [
      "gitlab",
      { CI_PIPELINE_URL: "https://gitlab.com/acme/repo/-/pipelines/123" },
      "https://gitlab.com/acme/repo/-/pipelines/123",
    ],
    [
      "azure-devops",
      {
        SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme/",
        SYSTEM_TEAMPROJECT: "Pipr Project",
        BUILD_BUILDID: "123",
      },
      "https://dev.azure.com/acme/Pipr%20Project/_build/results?buildId=123",
    ],
    [
      "bitbucket",
      {
        BITBUCKET_GIT_HTTP_ORIGIN: "https://bitbucket.org/acme/repo.git",
        BITBUCKET_BUILD_NUMBER: "123",
      },
      "https://bitbucket.org/acme/repo/pipelines/results/123",
    ],
  ])("derives the %s workflow URL from documented CI variables", (host, env, expected) => {
    expect(workflowUrlFromEnvironment(host, env)).toBe(expected);
  });

  it("omits incomplete, credentialed, and non-http URLs", () => {
    expect(
      workflowUrlFromEnvironment("github", {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
      }),
    ).toBeUndefined();
    expect(
      workflowUrlFromEnvironment("gitlab", {
        CI_PIPELINE_URL: "https://token@gitlab.com/acme/repo/-/pipelines/123",
      }),
    ).toBeUndefined();
    expect(
      workflowUrlFromEnvironment("gitlab", {
        CI_PIPELINE_URL: "file:///tmp/workflow",
      }),
    ).toBeUndefined();
  });
});
