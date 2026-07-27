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

  it("rejects invalid pipeline coordinates before loading the pull request", async () => {
    const validEnv: NodeJS.ProcessEnv = {
      BITBUCKET_WORKSPACE: "workspace",
      BITBUCKET_REPO_SLUG: "repository",
      BITBUCKET_PR_ID: "7",
    };
    let loadCalls = 0;
    const loadChangeRequest = async () => {
      loadCalls += 1;
      throw new Error("invalid coordinates must not load the pull request");
    };
    for (const name of ["BITBUCKET_WORKSPACE", "BITBUCKET_REPO_SLUG", "BITBUCKET_PR_ID"] as const) {
      for (const value of [undefined, ""]) {
        await expect(
          parseBitbucketEvent({
            env: { ...validEnv, [name]: value },
            workspace: "/workspace",
            loadChangeRequest,
          }),
        ).rejects.toThrow(`${name} is required for Bitbucket events`);
      }
    }
    for (const value of ["0", "-1", "1.5", "nope"]) {
      await expect(
        parseBitbucketEvent({
          env: { ...validEnv, BITBUCKET_PR_ID: value },
          workspace: "/workspace",
          loadChangeRequest,
        }),
      ).rejects.toThrow("BITBUCKET_PR_ID must be a positive integer");
    }
    expect(loadCalls).toBe(0);
  });

  it("ignores draft pipeline pull requests", async () => {
    await expect(
      parseBitbucketEvent({
        env: {
          BITBUCKET_WORKSPACE: "workspace",
          BITBUCKET_REPO_SLUG: "repository",
          BITBUCKET_PR_ID: "7",
        },
        workspace: "/workspace",
        loadChangeRequest: async () => ({
          ...loaded,
          change: { ...loaded.change, isDraft: true },
        }),
      }),
    ).resolves.toEqual({ kind: "ignored", reason: "pull request is a draft" });
  });

  it("accepts pull request webhooks whose actor omits the legacy nickname", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          actor: { display_name: "Developer" },
          repository,
          pullrequest: { id: 7 },
        }),
      );
      await expect(
        parseBitbucketEvent({
          eventPath,
          env: { BITBUCKET_EVENT_KEY: "pullrequest:updated" },
          workspace: "/workspace",
          loadChangeRequest: async () => loaded,
        }),
      ).resolves.toMatchObject({ kind: "change-request", change: { action: "updated" } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("ignores draft webhook pull requests without loading them", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          actor: { nickname: "developer" },
          repository,
          pullrequest: { id: 7, draft: true },
        }),
      );
      let loadedChange = false;
      await expect(
        parseBitbucketEvent({
          eventPath,
          env: { BITBUCKET_EVENT_KEY: "pullrequest:updated" },
          workspace: "/workspace",
          loadChangeRequest: async () => {
            loadedChange = true;
            return loaded;
          },
        }),
      ).resolves.toEqual({ kind: "ignored", reason: "pull request is a draft" });
      expect(loadedChange).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("normalizes root comments and replies", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({
          actor: { nickname: "developer" },
          repository: repository,
          pullrequest: { id: 7 },
          comment: { id: 4, content: { raw: "@pipr ask" } },
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
          actor: { nickname: "developer" },
          repository,
          pullrequest: { id: 7 },
          comment: { id: 5, content: { raw: "@pipr ask inline" }, inline: { to: 3 } },
        }),
      );
      await expect(parseBitbucketEvent(options)).resolves.toMatchObject({
        kind: "command-comment",
      });
      await Bun.write(
        eventPath,
        JSON.stringify({
          actor: { nickname: "developer" },
          repository,
          pullrequest: { id: 7 },
          comment: {
            id: 5,
            parent: { id: 4 },
            content: { raw: "fixed" },
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

  it("reports a missing comment payload for comment events", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({ actor: { nickname: "developer" }, repository, pullrequest: { id: 7 } }),
      );
      await expect(
        parseBitbucketEvent({
          eventPath,
          env: { BITBUCKET_EVENT_KEY: "pullrequest:comment_created" },
          workspace: "/workspace",
          loadChangeRequest: async () => loaded,
        }),
      ).rejects.toThrow("Bitbucket comment event payload is missing comment");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps terminal pull request events to closed and rejects unknown events", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(
        eventPath,
        JSON.stringify({ actor: { nickname: "developer" }, repository, pullrequest: { id: 7 } }),
      );
      const options = {
        eventPath,
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      };
      for (const eventKey of [
        "pullrequest:fulfilled",
        "pullrequest:rejected",
        "pullrequest:superseded",
      ]) {
        await expect(
          parseBitbucketEvent({
            ...options,
            env: { BITBUCKET_EVENT_KEY: eventKey },
          }),
        ).resolves.toMatchObject({ kind: "change-request", change: { action: "closed" } });
      }
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

describe("Bitbucket Data Center events", () => {
  it("normalizes pull request and comment webhooks", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-dc-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      const options = {
        eventPath,
        env: {
          BITBUCKET_BASE_URL: "https://bitbucket.example.com",
          BITBUCKET_EVENT_KEY: "pr:from_ref_updated",
        },
        workspace: "/workspace",
        loadChangeRequest: async (ref: {
          workspace: string;
          repository: string;
          changeNumber: number;
        }) => {
          expect(ref).toEqual({ workspace: "PRJ", repository: "pipr", changeNumber: 7 });
          return {
            ...loaded,
            repository: {
              slug: "PRJ/pipr",
              url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/browse",
            },
            coordinates: {
              provider: "bitbucket" as const,
              workspace: "PRJ",
              repository: "pipr",
              repositoryUuid: "42",
            },
          };
        },
      };
      await Bun.write(eventPath, JSON.stringify(dataCenterPayload));
      await expect(parseBitbucketEvent(options)).resolves.toMatchObject({
        kind: "change-request",
        change: {
          action: "updated",
          platform: { id: "bitbucket", host: "https://bitbucket.example.com" },
          repository: { slug: "PRJ/pipr" },
        },
      });
      for (const [eventKey, action] of [
        ["pr:opened", "opened"],
        ["pr:modified", "updated"],
      ] as const) {
        await expect(
          parseBitbucketEvent({
            ...options,
            env: { ...options.env, BITBUCKET_EVENT_KEY: eventKey },
          }),
        ).resolves.toMatchObject({ kind: "change-request", change: { action } });
      }

      await Bun.write(
        eventPath,
        JSON.stringify({
          ...dataCenterPayload,
          comment: { id: 11, text: "@pipr review", parent: { id: 10 } },
        }),
      );
      await expect(
        parseBitbucketEvent({
          ...options,
          env: { ...options.env, BITBUCKET_EVENT_KEY: "pr:comment:added" },
        }),
      ).resolves.toMatchObject({
        kind: "review-comment-reply",
        reply: {
          actor: "developer",
          body: "@pipr review",
          parentCommentId: "10",
          repository: {
            slug: "PRJ/pipr",
            url: "https://bitbucket.example.com/projects/PRJ/repos/pipr/browse",
          },
        },
      });

      await Bun.write(
        eventPath,
        JSON.stringify({
          ...dataCenterPayload,
          comment: { id: 12, text: "@pipr review" },
        }),
      );
      await expect(
        parseBitbucketEvent({
          ...options,
          env: { ...options.env, BITBUCKET_EVENT_KEY: "pr:comment:added" },
        }),
      ).resolves.toMatchObject({
        kind: "command-comment",
        comment: { commentId: "12", isChangeRequest: true },
      });

      await Bun.write(
        eventPath,
        JSON.stringify({
          ...dataCenterPayload,
          comment: { id: 13, text: "reply" },
          commentParentId: 12,
        }),
      );
      await expect(
        parseBitbucketEvent({
          ...options,
          env: { ...options.env, BITBUCKET_EVENT_KEY: "pr:comment:added" },
        }),
      ).resolves.toMatchObject({
        kind: "review-comment-reply",
        reply: { commentId: "13", parentCommentId: "12" },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("maps terminal Data Center pull request events and rejects unsupported events", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-bitbucket-dc-event-"));
    try {
      const eventPath = path.join(directory, "event.json");
      await Bun.write(eventPath, JSON.stringify(dataCenterPayload));
      const options = {
        eventPath,
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      };
      for (const eventKey of ["pr:merged", "pr:declined", "pr:deleted"]) {
        await expect(
          parseBitbucketEvent({
            ...options,
            env: {
              BITBUCKET_BASE_URL: "https://bitbucket.example.com",
              BITBUCKET_EVENT_KEY: eventKey,
            },
          }),
        ).resolves.toMatchObject({ kind: "change-request", change: { action: "closed" } });
      }
      await expect(
        parseBitbucketEvent({
          ...options,
          env: {
            BITBUCKET_BASE_URL: "https://bitbucket.example.com",
            BITBUCKET_EVENT_KEY: "pr:reviewer:approved",
          },
        }),
      ).rejects.toThrow("Unsupported Bitbucket Data Center event");
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

const dataCenterPayload = {
  actor: { name: "developer", slug: "developer" },
  repository: {
    id: 42,
    name: "pipr",
    slug: "pipr",
    project: { key: "PRJ" },
  },
  pullRequest: { id: 7, draft: false },
};
