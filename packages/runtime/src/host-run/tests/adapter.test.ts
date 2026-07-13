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
});
