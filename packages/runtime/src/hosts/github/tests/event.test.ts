import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGitHubPullRequestEventContext } from "../event.js";

describe("GitHub event parser", () => {
  it("normalizes GitHub pull request actions for core task selection", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-github-event-"));
    try {
      const eventPath = path.join(rootDir, "event.json");
      await writePullRequestEvent(eventPath, "synchronize");
      await expect(parseEvent(eventPath, rootDir)).resolves.toMatchObject({
        action: "updated",
        rawAction: "synchronize",
        platform: { id: "github" },
        repository: { slug: "local/pipr" },
        coordinates: { provider: "github", owner: "local", repository: "pipr" },
        change: {
          isFork: false,
          number: 1,
          base: { sha: "base" },
          head: { sha: "head" },
        },
      });

      await writePullRequestEvent(eventPath, "synchronize", "contributor/pipr");
      await expect(parseEvent(eventPath, rootDir)).resolves.toMatchObject({
        change: { isFork: true },
      });

      await writePullRequestEvent(eventPath, "ready_for_review");
      await expect(parseEvent(eventPath, rootDir)).resolves.toMatchObject({
        action: "ready",
        rawAction: "ready_for_review",
      });
    } finally {
      await rm(rootDir, { force: true, recursive: true });
    }
  });
});

async function parseEvent(eventPath: string, rootDir: string) {
  return await loadGitHubPullRequestEventContext({
    eventPath,
    env: {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "local/pipr",
      GITHUB_WORKSPACE: rootDir,
    },
    workspace: rootDir,
  });
}

async function writePullRequestEvent(
  eventPath: string,
  action: string,
  headRepository = "local/pipr",
): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action,
      number: 1,
      repository: { full_name: "local/pipr" },
      pull_request: {
        number: 1,
        title: "Test PR",
        body: "Test body",
        base: {
          sha: "base",
          ref: "main",
          repo: { full_name: "local/pipr" },
        },
        head: {
          sha: "head",
          ref: "branch",
          repo: { full_name: headRepository },
        },
      },
    }),
  );
}
