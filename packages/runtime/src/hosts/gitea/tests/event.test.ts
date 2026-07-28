import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LoadedChangeRequest } from "../../types.js";
import { parseGiteaEvent } from "../event.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("Gitea-compatible events", () => {
  it("parses a Forgejo pull request webhook through the API-backed change loader", async () => {
    const eventPath = await writeEvent({
      action: "synchronized",
      number: 7,
      pull_request: { draft: false },
      repository: {
        full_name: "acme/pipr",
        html_url: "https://forge.example.com/acme/pipr",
      },
      sender: { login: "contributor" },
    });

    await expect(
      parseGiteaEvent({
        host: "forgejo",
        eventPath,
        env: { FORGEJO_EVENT_NAME: "pull_request_sync" },
        workspace: "/workspace",
        loadChangeRequest: async (ref) => {
          expect(ref).toEqual({ owner: "acme", repository: "pipr", changeNumber: 7 });
          return loadedChange;
        },
      }),
    ).resolves.toMatchObject({
      kind: "change-request",
      change: {
        eventName: "pull_request",
        action: "updated",
        rawAction: "synchronized",
        platform: { id: "forgejo", host: "https://forge.example.com" },
        repository: { slug: "acme/pipr" },
        coordinates: { provider: "gitea", owner: "acme", repository: "pipr" },
        change: { number: 7, head: { sha: "head" } },
        workspace: "/workspace",
      },
    });
  });

  it("normalizes a ready-for-review pull request action", async () => {
    const eventPath = await writeEvent({
      action: "ready_for_review",
      number: 7,
      pull_request: { draft: false },
      repository: {
        full_name: "acme/pipr",
        html_url: "https://gitea.example.com/acme/pipr",
      },
      sender: { login: "contributor" },
    });

    await expect(
      parseGiteaEvent({
        host: "gitea",
        eventPath,
        env: { GITEA_EVENT_NAME: "pull_request" },
        workspace: "/workspace",
        loadChangeRequest: async () => loadedChange,
      }),
    ).resolves.toMatchObject({
      kind: "change-request",
      change: {
        action: "ready",
        rawAction: "ready_for_review",
      },
    });
  });

  it("marks ordinary issue comments as non-pull-request commands", async () => {
    const eventPath = await writeEvent({
      action: "created",
      is_pull: false,
      issue: { number: 7 },
      comment: { id: 12, body: "@pipr review" },
      repository: {
        full_name: "acme/pipr",
        html_url: "https://codeberg.org/acme/pipr",
      },
      sender: { login: "contributor" },
    });

    await expect(
      parseGiteaEvent({
        host: "codeberg",
        eventPath,
        env: { GITEA_EVENT_NAME: "issue_comment" },
        workspace: "/workspace",
        loadChangeRequest: async () => {
          throw new Error("ordinary issue comments must not load a change request");
        },
      }),
    ).resolves.toMatchObject({
      kind: "command-comment",
      comment: {
        changeNumber: 7,
        commentId: "12",
        isChangeRequest: false,
      },
    });
  });

  it("marks native pull request timeline comments as pull request commands", async () => {
    const eventPath = await writeEvent({
      action: "created",
      is_pull: true,
      issue: { number: 7 },
      pull_request: { number: 7 },
      comment: { id: 13, body: "@pipr review" },
      repository: {
        full_name: "acme/pipr",
        html_url: "https://gitea.example.com/acme/pipr",
      },
      sender: { login: "contributor" },
    });

    await expect(
      parseGiteaEvent({
        host: "gitea",
        eventPath,
        env: { GITEA_EVENT_NAME: "issue_comment" },
        workspace: "/workspace",
        loadChangeRequest: async () => loadedChange,
      }),
    ).resolves.toMatchObject({
      kind: "command-comment",
      comment: {
        changeNumber: 7,
        commentId: "13",
        isChangeRequest: true,
      },
    });
  });

  it("ignores native review payloads because they do not identify inline replies", async () => {
    const eventPath = await writeEvent({
      action: "reviewed",
      number: 7,
      pull_request: { number: 7 },
      review: { type: "comment", content: "Looks good." },
      repository: {
        full_name: "acme/pipr",
        html_url: "https://gitea.example.com/acme/pipr",
      },
      sender: { login: "reviewer" },
    });

    await expect(
      parseGiteaEvent({
        host: "gitea",
        eventPath,
        env: { GITEA_EVENT_NAME: "pull_request_review_comment" },
        workspace: "/workspace",
        loadChangeRequest: async () => {
          throw new Error("review payload must not load a change request");
        },
      }),
    ).resolves.toEqual({
      kind: "ignored",
      reason: "Gitea-compatible review replies are not supported",
    });
  });

  it("rejects unsupported native event types before parsing their payload", async () => {
    const eventPath = await writeEvent({ ref: "refs/heads/main" });

    await expect(
      parseGiteaEvent({
        host: "forgejo",
        eventPath,
        env: { FORGEJO_EVENT_NAME: "push" },
        workspace: "/workspace",
        loadChangeRequest: async () => {
          throw new Error("unsupported events must not load a change request");
        },
      }),
    ).rejects.toThrow("Unsupported Forgejo event 'push'");
  });
});

async function writeEvent(value: unknown): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-gitea-event-"));
  temporaryDirectories.push(directory);
  const eventPath = path.join(directory, "event.json");
  await Bun.write(eventPath, JSON.stringify(value));
  return eventPath;
}

const loadedChange: LoadedChangeRequest = {
  repository: { slug: "acme/pipr", url: "https://forge.example.com/acme/pipr" },
  coordinates: { provider: "gitea", owner: "acme", repository: "pipr" },
  change: {
    number: 7,
    title: "Add adapter",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
    isFork: false,
    isDraft: false,
  },
};
