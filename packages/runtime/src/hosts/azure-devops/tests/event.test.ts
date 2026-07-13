import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseAzureDevOpsEvent } from "../event.js";

describe("Azure DevOps event parser", () => {
  it("normalizes branch-policy pipeline variables", async () => {
    await expect(
      parseAzureDevOpsEvent({
        env: {
          TF_BUILD: "True",
          SYSTEM_PULLREQUEST_PULLREQUESTID: "7",
          SYSTEM_TEAMPROJECT: "project",
          BUILD_REPOSITORY_ID: "repo-id",
          SYSTEM_COLLECTIONURI: "https://dev.azure.com/org/",
          PIPR_CHANGE_ACTION: "updated",
        },
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      }),
    ).resolves.toMatchObject({
      kind: "change-request",
      change: {
        eventName: "azure_pipeline",
        action: "updated",
        platform: { id: "azure-devops", host: "https://dev.azure.com/org" },
        change: { number: 7 },
      },
    });
  });

  it("ignores draft branch-policy pull requests", async () => {
    await expect(
      parseAzureDevOpsEvent({
        env: {
          SYSTEM_PULLREQUEST_PULLREQUESTID: "7",
          SYSTEM_TEAMPROJECT: "project",
          BUILD_REPOSITORY_ID: "repo-id",
          SYSTEM_COLLECTIONURI: "https://dev.azure.com/org/",
        },
        workspace: "/workspace",
        loadChangeRequest: async () => ({
          ...loaded,
          change: { ...loaded.change, isDraft: true },
        }),
      }),
    ).resolves.toEqual({ kind: "ignored", reason: "pull request is a draft" });
  });

  it("normalizes service-hook PR creation and update events", async () => {
    for (const [eventType, expectedAction] of [
      ["git.pullrequest.created", "opened"],
      ["git.pullrequest.updated", "updated"],
    ] as const) {
      const fixture = await eventFixture({
        id: `event-${expectedAction}`,
        eventType,
        resource: {
          pullRequestId: 7,
          repository: { id: "repo-id", project: { id: "project-id", name: "project" } },
        },
        resourceContainers: {
          account: { baseUrl: "https://dev.azure.com/org/" },
          project: { id: "project-id", baseUrl: "https://dev.azure.com/org/project/" },
        },
      });
      try {
        await expect(
          parseAzureDevOpsEvent({
            eventPath: fixture.path,
            env: {},
            workspace: fixture.root,
            loadChangeRequest: async () => loaded,
          }),
        ).resolves.toMatchObject({
          kind: "change-request",
          change: { action: expectedAction, rawAction: eventType },
        });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  it("ignores draft service-hook pull requests without loading them", async () => {
    const fixture = await eventFixture({
      id: "event-draft",
      eventType: "git.pullrequest.updated",
      resource: {
        pullRequestId: 7,
        isDraft: true,
        repository: { id: "repo-id", project: { id: "project-id", name: "project" } },
      },
      resourceContainers: { account: { baseUrl: "https://dev.azure.com/org/" } },
    });
    let loadedChange = false;
    try {
      await expect(
        parseAzureDevOpsEvent({
          eventPath: fixture.path,
          env: {},
          workspace: fixture.root,
          loadChangeRequest: async () => {
            loadedChange = true;
            return loaded;
          },
        }),
      ).resolves.toEqual({ kind: "ignored", reason: "pull request is a draft" });
      expect(loadedChange).toBe(false);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes root comments as commands and replies as review replies", async () => {
    for (const [parentCommentId, expectedKind] of [
      [0, "command-comment"],
      [101, "review-comment-reply"],
    ] as const) {
      const fixture = await eventFixture({
        id: `event-${expectedKind}`,
        eventType: "ms.vss-code.git-pullrequest-comment-event",
        resource: {
          comment: {
            id: 102,
            parentCommentId,
            content: parentCommentId ? "Fixed." : "@pipr review",
            author: { uniqueName: "developer@example.com" },
          },
          pullRequest: {
            pullRequestId: 7,
            repository: {
              id: "repo-id",
              name: "repository",
              project: { id: "project-id", name: "project" },
            },
          },
        },
        resourceContainers: { account: { baseUrl: "https://dev.azure.com/org/" } },
      });
      try {
        await expect(
          parseAzureDevOpsEvent({ eventPath: fixture.path, env: {}, workspace: fixture.root }),
        ).resolves.toMatchObject(
          expectedKind === "command-comment"
            ? { kind: expectedKind, comment: { commentId: "102", changeNumber: 7 } }
            : {
                kind: expectedKind,
                reply: { commentId: "102", parentCommentId: "101", changeNumber: 7 },
              },
        );
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });
});

const loaded = {
  repository: { slug: "org/project/repository" },
  coordinates: {
    provider: "azure-devops" as const,
    organization: "org",
    project: "project",
    projectId: "project-id",
    repositoryId: "repo-id",
  },
  change: {
    number: 7,
    title: "Test PR",
    description: "",
    base: { sha: "base", ref: "main" },
    head: { sha: "head", ref: "feature" },
  },
};

async function eventFixture(payload: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-azure-event-"));
  const eventPath = path.join(root, "event.json");
  await Bun.write(eventPath, JSON.stringify(payload));
  return { root, path: eventPath };
}
