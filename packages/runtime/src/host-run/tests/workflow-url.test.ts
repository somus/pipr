import { describe, expect, it } from "bun:test";
import { failureActionFromEnvironment } from "../workflow-url.js";

describe("failureActionFromEnvironment", () => {
  it("offers a GitHub-native failed-job rerun affordance without implying one-click retry", () => {
    const env = {
      GITHUB_SERVER_URL: "https://github.example.com",
      GITHUB_REPOSITORY: "acme/repo",
      GITHUB_RUN_ID: "123",
    };

    expect(failureActionFromEnvironment("github", env)).toEqual({
      label: "Open workflow to rerun failed jobs",
      url: "https://github.example.com/acme/repo/actions/runs/123",
    });
    expect(failureActionFromEnvironment("gitea", env)).toBeUndefined();
    expect(failureActionFromEnvironment("github", {})).toBeUndefined();
  });
});
