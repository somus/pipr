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
        env: {},
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
        action: "synchronized",
        platform: { id: "forgejo", host: "https://forge.example.com" },
        repository: { slug: "acme/pipr" },
        coordinates: { provider: "gitea", owner: "acme", repository: "pipr" },
        change: { number: 7, head: { sha: "head" } },
        workspace: "/workspace",
      },
    });
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
