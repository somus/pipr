import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseBitbucketEvent } from "../event.js";

describe("Bitbucket Cloud events", () => {
  it("normalizes pipeline pull requests", async () => {
    await expect(
      parseBitbucketEvent({
        env: {
          BITBUCKET_WORKSPACE: "workspace",
          BITBUCKET_REPO_SLUG: "repository",
          BITBUCKET_PR_ID: "7",
          PIPR_CHANGE_ACTION: "opened",
        },
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      }),
    ).resolves.toMatchObject({ kind: "change-request", change: { action: "opened" } });
  });

  it("normalizes root comments and replies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          repository: repository,
          pullrequest: { id: 7 },
          comment: { id: 4, content: { raw: "@pipr ask" }, user: { nickname: "developer" } },
        }),
      );
      const options = {
        eventPath,
        env: { BITBUCKET_EVENT_KEY: "pullrequest:comment_created" },
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      };
      await expect(parseBitbucketEvent(options)).resolves.toMatchObject({
        kind: "command-comment",
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          repository,
          pullrequest: { id: 7 },
          comment: {
            id: 5,
            parent: { id: 4 },
            content: { raw: "fixed" },
            user: { nickname: "developer" },
          },
        }),
      );
      await expect(parseBitbucketEvent(options)).resolves.toMatchObject({
        kind: "review-comment-reply",
        reply: { parentCommentId: "4" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps terminal pull request events to closed and rejects unknown events", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(eventPath, JSON.stringify({ repository, pullrequest: { id: 7 } }));
      const options = {
        eventPath,
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      };
      await expect(
        parseBitbucketEvent({
          ...options,
          env: { BITBUCKET_EVENT_KEY: "pullrequest:fulfilled" },
        }),
      ).resolves.toMatchObject({ kind: "change-request", change: { action: "closed" } });
      await expect(
        parseBitbucketEvent({
          ...options,
          env: { BITBUCKET_EVENT_KEY: "pullrequest:approved" },
        }),
      ).rejects.toThrow("Unsupported Bitbucket event");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const repository = {
  uuid: "{repo}",
  name: "repository",
  full_name: "workspace/repository",
  slug: "repository",
  links: { html: { href: "https://bitbucket.org/workspace/repository" } },
};
const loaded = {
  repository: { slug: "workspace/repository" },
  coordinates: {
    provider: "bitbucket" as const,
    workspace: "workspace",
    repository: "repository",
    repositoryUuid: "{repo}",
  },
  change: {
    number: 7,
    title: "PR",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
};
