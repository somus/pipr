import { describe, expect, it } from "bun:test";
import { createGitLabClient } from "../client.js";

describe("GitLab API client", () => {
  it("uses the target branch tip as the trusted base commit", async () => {
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async () =>
      Response.json({
        iid: 7,
        title: "Update fixture",
        description: null,
        web_url: "https://gitlab.com/group/project/-/merge_requests/7",
        source_branch: "feature",
        target_branch: "main",
        source_project_id: 42,
        target_project_id: 42,
        sha: "head",
        diff_refs: { base_sha: "merge-base", start_sha: "target-tip", head_sha: "head" },
      }),
    );

    await expect(
      client.loadChange({ projectId: "42", projectPath: "group/project", changeNumber: 7 }),
    ).resolves.toMatchObject({
      change: {
        base: { sha: "target-tip", ref: "main" },
        head: { sha: "head", ref: "feature" },
      },
    });
  });
});
