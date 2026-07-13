import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseGitLabEvent } from "../event.js";

describe("GitLab event parser", () => {
  it("normalizes merge request webhooks with GitLab coordinates", async () => {
    const fixture = await eventFixture({
      object_kind: "merge_request",
      project: {
        id: 42,
        path_with_namespace: "group/project",
        web_url: "https://gitlab.com/group/project",
      },
      object_attributes: {
        iid: 7,
        action: "update",
        title: "Test MR",
        description: "Body",
        url: "https://gitlab.com/group/project/-/merge_requests/7",
        source_branch: "feature",
        target_branch: "main",
        source_project_id: 42,
        target_project_id: 42,
        last_commit: { id: "head" },
      },
      changes: { last_commit: { previous: { id: "old" }, current: { id: "head" } } },
      user: { username: "developer" },
    });
    try {
      await expect(
        parseGitLabEvent({
          eventPath: fixture.path,
          env: {},
          workspace: fixture.root,
          loadChangeRequest: async () => ({
            repository: { slug: "group/project" },
            coordinates: { provider: "gitlab", projectId: "42", projectPath: "group/project" },
            change: {
              number: 7,
              title: "Test MR",
              description: "Body",
              base: { sha: "base", ref: "main" },
              head: { sha: "head", ref: "feature" },
            },
          }),
        }),
      ).resolves.toMatchObject({
        kind: "change-request",
        change: {
          action: "updated",
          rawAction: "update",
          platform: { id: "gitlab", host: "https://gitlab.com" },
          repository: { slug: "group/project" },
          coordinates: { provider: "gitlab", projectId: "42", projectPath: "group/project" },
          change: { number: 7, base: { ref: "main" }, head: { sha: "head", ref: "feature" } },
        },
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("normalizes merge request notes as commands and discussion replies", async () => {
    const base = {
      object_kind: "note",
      project: { id: 42, path_with_namespace: "group/project" },
      merge_request: { iid: 7 },
      user: { username: "developer" },
    };
    const command = await eventFixture({
      ...base,
      object_attributes: {
        id: 101,
        note: "@pipr review",
        action: "create",
        noteable_type: "MergeRequest",
      },
    });
    const reply = await eventFixture({
      ...base,
      object_attributes: {
        id: 102,
        note: "This is fixed.",
        action: "create",
        noteable_type: "MergeRequest",
        discussion_id: "discussion-1",
      },
    });
    try {
      await expect(
        parseGitLabEvent({ eventPath: command.path, env: {}, workspace: command.root }),
      ).resolves.toMatchObject({
        kind: "command-comment",
        comment: { commentId: "101", changeNumber: 7, body: "@pipr review", actor: "developer" },
      });
      await expect(
        parseGitLabEvent({
          eventPath: reply.path,
          env: {},
          workspace: reply.root,
          resolveReplyParent: async ({ noteId }) => (noteId === "102" ? "101" : undefined),
        }),
      ).resolves.toMatchObject({
        kind: "review-comment-reply",
        reply: { commentId: "102", parentCommentId: "101", changeNumber: 7 },
      });
    } finally {
      await rm(command.root, { recursive: true, force: true });
      await rm(reply.root, { recursive: true, force: true });
    }
  });

  it("normalizes draft-to-ready merge request updates", async () => {
    const fixture = await eventFixture({
      object_kind: "merge_request",
      project: { id: 42, path_with_namespace: "group/project" },
      object_attributes: { iid: 7, action: "update" },
      changes: { draft: { previous: true, current: false } },
    });
    try {
      await expect(
        parseGitLabEvent({
          eventPath: fixture.path,
          env: {},
          workspace: fixture.root,
          loadChangeRequest: async () => ({
            repository: { slug: "group/project" },
            coordinates: { provider: "gitlab", projectId: "42", projectPath: "group/project" },
            change: {
              number: 7,
              title: "Ready MR",
              description: "",
              base: { sha: "base", ref: "main" },
              head: { sha: "head", ref: "feature" },
            },
          }),
        }),
      ).resolves.toMatchObject({ kind: "change-request", change: { action: "ready" } });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("ignores draft merge request webhooks before loading the change", async () => {
    const fixture = await eventFixture({
      object_kind: "merge_request",
      project: { id: 42, path_with_namespace: "group/project" },
      object_attributes: { iid: 7, action: "open", draft: true },
    });
    let loadCalls = 0;
    try {
      await expect(
        parseGitLabEvent({
          eventPath: fixture.path,
          env: {},
          workspace: fixture.root,
          loadChangeRequest: async () => {
            loadCalls += 1;
            throw new Error("draft merge requests must not be loaded");
          },
        }),
      ).resolves.toEqual({ kind: "ignored", reason: "merge request is a draft" });
      expect(loadCalls).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("synthesizes pipeline change events from GitLab CI variables", async () => {
    const loaded = {
      repository: { slug: "group/project" },
      coordinates: { provider: "gitlab" as const, projectId: "42", projectPath: "group/project" },
      change: {
        number: 7,
        title: "Test MR",
        description: "",
        base: { sha: "base", ref: "main" },
        head: { sha: "head", ref: "feature" },
      },
    };
    await expect(
      parseGitLabEvent({
        env: {
          GITLAB_CI: "true",
          CI_PROJECT_ID: "42",
          CI_PROJECT_PATH: "group/project",
          CI_MERGE_REQUEST_IID: "7",
        },
        workspace: "/workspace",
        loadChangeRequest: async () => loaded,
      }),
    ).resolves.toMatchObject({
      kind: "change-request",
      change: { action: "updated", change: { number: 7 } },
    });
  });

  it("ignores draft merge requests loaded by GitLab pipelines", async () => {
    await expect(
      parseGitLabEvent({
        env: {
          CI_PROJECT_ID: "42",
          CI_PROJECT_PATH: "group/project",
          CI_MERGE_REQUEST_IID: "7",
        },
        workspace: "/workspace",
        loadChangeRequest: async () => ({
          repository: { slug: "group/project" },
          coordinates: { provider: "gitlab", projectId: "42", projectPath: "group/project" },
          change: {
            number: 7,
            title: "Draft MR",
            description: "",
            base: { sha: "base", ref: "main" },
            head: { sha: "head", ref: "feature" },
            isDraft: true,
          },
        }),
      }),
    ).resolves.toEqual({ kind: "ignored", reason: "merge request is a draft" });
  });
});

async function eventFixture(payload: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-gitlab-event-"));
  const eventPath = path.join(root, "event.json");
  await Bun.write(eventPath, JSON.stringify(payload));
  return { root, path: eventPath };
}
