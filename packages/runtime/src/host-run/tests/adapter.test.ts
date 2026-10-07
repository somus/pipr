import { describe, expect, it } from "bun:test";
import { createHostRunAdapter } from "../adapter.js";

describe("host-run adapter selection", () => {
  const gitlab = { GITLAB_TOKEN: "test-token" };
  const azure = {
    AZURE_DEVOPS_TOKEN: "test-token",
    AZURE_DEVOPS_ORGANIZATION: "org",
    AZURE_DEVOPS_PROJECT: "project",
  };
  const bitbucket = {
    BITBUCKET_WORKSPACE: "workspace",
    BITBUCKET_REPO_SLUG: "repository",
    BITBUCKET_EMAIL: "pipr@example.com",
    BITBUCKET_API_TOKEN: "token",
  };
  const forgejo = { FORGEJO_ACTIONS: "true", FORGEJO_TOKEN: "token" };

  it.each<[string, string | undefined, NodeJS.ProcessEnv]>([
    ["gitlab", "gitlab", gitlab],
    ["gitlab", undefined, { ...gitlab, GITLAB_CI: "true" }],
    ["azure-devops", "azure-devops", azure],
    ["azure-devops", undefined, { ...azure, TF_BUILD: "True" }],
    ["bitbucket", "bitbucket", bitbucket],
    ["bitbucket", undefined, { ...bitbucket, BITBUCKET_BUILD_NUMBER: "1" }],
    ["gitea", "gitea", { GITEA_TOKEN: "token", GITEA_SERVER_URL: "https://gitea.example.com" }],
    ["forgejo", undefined, { ...forgejo, FORGEJO_SERVER_URL: "https://forge.example.com" }],
    ["codeberg", undefined, { ...forgejo, FORGEJO_SERVER_URL: "https://codeberg.org" }],
  ])("selects %s (explicit host: %s)", (expected, host, env) => {
    expect(createHostRunAdapter({ host, env }).id).toBe(expected);
  });

  it.each<[string, NodeJS.ProcessEnv, string]>([
    ["gitlab", {}, "GITLAB_TOKEN or CI_JOB_TOKEN is required"],
    [
      "azure-devops",
      { AZURE_DEVOPS_TOKEN: "token" },
      "AZURE_DEVOPS_ORGANIZATION, AZURE_DEVOPS_COLLECTION_URL, or SYSTEM_COLLECTIONURI is required",
    ],
    ["forgejo", { FORGEJO_SERVER_URL: "https://forge.example.com" }, "FORGEJO_TOKEN is required"],
  ])("fails %s selection before execution without credentials", (host, env, message) => {
    expect(() => createHostRunAdapter({ host, env })).toThrow(message);
  });
});
