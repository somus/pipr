import { describe, expect, it } from "bun:test";
import { ciRunFromEnvironment, isNativeCiEnvironment } from "../ci-run.js";

describe("ciRunFromEnvironment", () => {
  it.each([
    [
      "github",
      {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_JOB: "review",
      },
      {
        runId: "123",
        jobId: "review",
        runUrl: "https://github.com/acme/repo/actions/runs/123",
      },
    ],
    [
      "gitea",
      {
        GITHUB_SERVER_URL: "https://gitea.example.com/",
        GITHUB_REPOSITORY: "acme/repo",
        GITHUB_RUN_ID: "123",
        GITHUB_JOB: "review",
      },
      {
        runId: "123",
        jobId: "review",
        runUrl: "https://gitea.example.com/acme/repo/actions/runs/123",
      },
    ],
    [
      "forgejo",
      {
        FORGEJO_SERVER_URL: "https://forge.example.com",
        FORGEJO_REPOSITORY: "acme/repo",
        FORGEJO_RUN_ID: "123",
        FORGEJO_JOB: "review",
      },
      {
        runId: "123",
        jobId: "review",
        runUrl: "https://forge.example.com/acme/repo/actions/runs/123",
      },
    ],
    [
      "codeberg",
      {
        FORGEJO_SERVER_URL: "https://codeberg.org",
        FORGEJO_REPOSITORY: "acme/repo",
        FORGEJO_RUN_ID: "123",
      },
      { runId: "123", runUrl: "https://codeberg.org/acme/repo/actions/runs/123" },
    ],
    [
      "gitlab",
      {
        CI_PIPELINE_ID: "123",
        CI_JOB_ID: "456",
        CI_PIPELINE_URL: "https://gitlab.com/acme/repo/-/pipelines/123",
        CI_JOB_URL: "https://gitlab.com/acme/repo/-/jobs/456",
      },
      {
        runId: "123",
        jobId: "456",
        runUrl: "https://gitlab.com/acme/repo/-/pipelines/123",
        jobUrl: "https://gitlab.com/acme/repo/-/jobs/456",
      },
    ],
    [
      "azure-devops",
      {
        SYSTEM_COLLECTIONURI: "https://dev.azure.com/acme/",
        SYSTEM_TEAMPROJECT: "Pipr Project",
        BUILD_BUILDID: "123",
        SYSTEM_JOBID: "job-1",
      },
      {
        runId: "123",
        jobId: "job-1",
        runUrl: "https://dev.azure.com/acme/Pipr%20Project/_build/results?buildId=123",
      },
    ],
    [
      "bitbucket",
      {
        BITBUCKET_GIT_HTTP_ORIGIN: "https://bitbucket.org/acme/repo.git",
        BITBUCKET_BUILD_NUMBER: "123",
        BITBUCKET_PIPELINE_UUID: "{pipeline}",
        BITBUCKET_STEP_UUID: "{step}",
      },
      {
        runId: "{pipeline}",
        jobId: "{step}",
        runUrl: "https://bitbucket.org/acme/repo/pipelines/results/123",
      },
    ],
  ])("derives the %s run from documented CI variables", (host, env, expected) => {
    expect(ciRunFromEnvironment(host, env)).toEqual(expected);
  });

  it("reads the Azure DevOps collection from SYSTEM_COLLECTIONURI only", () => {
    expect(
      ciRunFromEnvironment("azure-devops", {
        SYSTEM_TEAMFOUNDATIONCOLLECTIONURI: "https://dev.azure.com/acme/",
        SYSTEM_TEAMPROJECT: "Pipr Project",
        BUILD_BUILDID: "123",
      }),
    ).toEqual({ runId: "123" });
  });

  it("falls back to the Bitbucket build number when no pipeline UUID is set", () => {
    expect(
      ciRunFromEnvironment("bitbucket", {
        BITBUCKET_GIT_HTTP_ORIGIN: "https://bitbucket.org/acme/repo",
        BITBUCKET_BUILD_NUMBER: "123",
      }),
    ).toEqual({ runId: "123", runUrl: "https://bitbucket.org/acme/repo/pipelines/results/123" });
  });

  it("omits incomplete, credentialed, non-http, and oversized URLs", () => {
    expect(
      ciRunFromEnvironment("github", {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo",
      }),
    ).toBeUndefined();
    expect(
      ciRunFromEnvironment("gitlab", {
        CI_PIPELINE_URL: "https://token@gitlab.com/acme/repo/-/pipelines/123",
        CI_JOB_URL: "file:///tmp/job",
      }),
    ).toBeUndefined();
    expect(
      ciRunFromEnvironment("gitlab", {
        CI_PIPELINE_ID: "123",
        CI_PIPELINE_URL: `https://gitlab.com/${"a".repeat(2_000)}`,
      }),
    ).toEqual({ runId: "123" });
  });

  it("encodes repository and run path segments", () => {
    expect(
      ciRunFromEnvironment("github", {
        GITHUB_SERVER_URL: "https://github.com",
        GITHUB_REPOSITORY: "acme/repo name",
        GITHUB_RUN_ID: "1#2",
      })?.runUrl,
    ).toBe("https://github.com/acme/repo%20name/actions/runs/1%232");
  });

  it("derives nothing for hosts without a CI run", () => {
    expect(ciRunFromEnvironment("local", { GITHUB_RUN_ID: "123" })).toBeUndefined();
  });
});

describe("isNativeCiEnvironment", () => {
  it.each([
    { GITHUB_ACTIONS: "true" },
    { GITLAB_CI: "true" },
    { TF_BUILD: "True" },
    { BITBUCKET_BUILD_NUMBER: "1" },
    { GITEA_ACTIONS: "true" },
    { FORGEJO_ACTIONS: "true" },
  ])("detects %o", (env) => {
    expect(isNativeCiEnvironment(env)).toBe(true);
  });

  it("treats other environments as local", () => {
    expect(isNativeCiEnvironment({ GITHUB_ACTIONS: "false" })).toBe(false);
  });
});
