import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadGitHubPullRequestEventContext, loadGitHubReviewCommentReplyEvent } from "../event.js";

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
        change: {
          number: 1,
          base: { sha: "base" },
          head: { sha: "head" },
        },
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

  it("loads review comment reply events for verifier dispatch", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-github-event-"));
    try {
      const eventPath = path.join(rootDir, "event.json");
      await writeReviewCommentEvent(eventPath);
      await expect(parseReviewCommentEvent(eventPath, rootDir)).resolves.toMatchObject({
        eventName: "pull_request_review_comment",
        action: "created",
        rawAction: "created",
        repository: { slug: "local/pipr" },
        changeNumber: 7,
        commentId: 456,
        parentCommentId: 123,
        body: "This finding is unnecessary because the caller validates it.",
        actor: "octo-dev",
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

async function parseReviewCommentEvent(eventPath: string, rootDir: string) {
  return await loadGitHubReviewCommentReplyEvent({
    eventPath,
    env: {
      GITHUB_EVENT_NAME: "pull_request_review_comment",
      GITHUB_REPOSITORY: "local/pipr",
      GITHUB_WORKSPACE: rootDir,
    },
    workspace: rootDir,
  });
}

async function writePullRequestEvent(eventPath: string, action: string): Promise<void> {
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
          repo: { full_name: "local/pipr" },
        },
      },
    }),
  );
}

async function writeReviewCommentEvent(eventPath: string): Promise<void> {
  await Bun.write(
    eventPath,
    JSON.stringify({
      action: "created",
      repository: { full_name: "local/pipr" },
      pull_request: { number: 7 },
      comment: {
        id: 456,
        in_reply_to_id: 123,
        body: "This finding is unnecessary because the caller validates it.",
        user: { login: "octo-dev" },
      },
    }),
  );
}
