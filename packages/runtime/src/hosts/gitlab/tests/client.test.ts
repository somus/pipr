import { describe, expect, it } from "bun:test";
import { runCodeHostPaginationContract } from "../../tests/adapter-contract.js";
import { createGitLabClient } from "../client.js";

describe("GitLab API client", () => {
  it("resolves canonical project coordinates", async () => {
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async (input) => {
      expect(String(input)).toContain("projects/group%2Fproject");
      return Response.json({ id: 42, path_with_namespace: "group/project" });
    });

    await expect(client.getProject("group/project")).resolves.toEqual({
      id: "42",
      path: "group/project",
    });
  });

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

  it("retries merge requests until GitLab prepares diff refs", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createGitLabClient(
      { GITLAB_TOKEN: "test-token" },
      async () =>
        Response.json({
          ...mergeRequest,
          diff_refs:
            ++calls === 1
              ? null
              : { base_sha: "merge-base", start_sha: "target-tip", head_sha: "head" },
        }),
      async (milliseconds) => waits.push(milliseconds),
    );

    await expect(client.getMergeRequest("42", 7)).resolves.toMatchObject({
      diff_refs: { head_sha: "head" },
    });
    expect(calls).toBe(2);
    expect(waits).toEqual([250]);
  });

  it("maps GitLab access levels and resolves reply parents to root note IDs", async () => {
    const levels = new Map([
      ["guest", 10],
      ["planner", 15],
      ["reporter", 20],
      ["developer", 30],
      ["maintainer", 40],
      ["owner", 50],
    ]);
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async (input) => {
      const url = String(input);
      if (url.includes("/users?")) {
        const username = new URL(url).searchParams.get("username") ?? "";
        return Response.json([{ id: 1, username }]);
      }
      if (url.includes("/members/all/")) {
        const username = [...levels.keys()].find((candidate) => url.includes(candidate));
        return Response.json({ access_level: levels.get(username ?? "guest") });
      }
      return Response.json({
        id: "discussion-1",
        notes: [
          { id: 101, body: "root" },
          { id: 102, body: "reply" },
        ],
      });
    });

    await expect(client.getRepositoryPermission("guest", "guest")).resolves.toBe("read");
    await expect(client.getRepositoryPermission("planner", "planner")).resolves.toBe("triage");
    await expect(client.getRepositoryPermission("reporter", "reporter")).resolves.toBe("triage");
    await expect(client.getRepositoryPermission("developer", "developer")).resolves.toBe("write");
    await expect(client.getRepositoryPermission("maintainer", "maintainer")).resolves.toBe(
      "maintain",
    );
    await expect(client.getRepositoryPermission("owner", "owner")).resolves.toBe("admin");
    await expect(client.findReplyParent("42", 7, "102", "discussion-1")).resolves.toBe("101");
    await expect(client.findReplyParent("42", 7, "102")).resolves.toBeUndefined();
  });

  it("maps missing GitLab memberships by HTTP status", async () => {
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async (input) => {
      if (String(input).includes("/users?")) {
        return Response.json([{ id: 1, username: "outside-user" }]);
      }
      return new Response("missing", { status: 404 });
    });

    await expect(client.getRepositoryPermission("42", "outside-user")).resolves.toBe("none");
  });

  it("bounds pagination when GitLab never returns a terminal page", async () => {
    let calls = 0;
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: "note" }));
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async () => {
      calls += 1;
      if (calls > 100) throw new Error("fixture exhausted");
      return Response.json(fullPage);
    });

    await expect(client.listNotes("42", 7)).rejects.toThrow("exceeded 100 pages");
    expect(calls).toBe(100);
  });

  it("sends bounded commit statuses through the GitLab write contract", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async (input, init) => {
      requests.push({ url: String(input), init });
      return Response.json({ id: 99 });
    });

    await expect(
      client.setStatus("group/project", "head", "review", "failure", "x".repeat(300)),
    ).resolves.toBe("99");
    expect(requests[0]?.url).toContain("projects/group%2Fproject/statuses/head");
    expect(requests[0]?.init?.headers).toMatchObject({
      "content-type": "application/json",
      "private-token": "test-token",
    });
    expect(JSON.parse(String(requests[0]?.init?.body))).toMatchObject({
      state: "failed",
      name: "review",
    });
    expect(JSON.parse(String(requests[0]?.init?.body)).description).toHaveLength(255);
  });

  it("retries transient GitLab commit status conflicts", async () => {
    let calls = 0;
    const waits: number[] = [];
    const client = createGitLabClient(
      { GITLAB_TOKEN: "test-token" },
      async () =>
        ++calls === 1
          ? new Response("status update in progress", { status: 409 })
          : Response.json({ id: 99 }),
      async (milliseconds) => waits.push(milliseconds),
    );

    await expect(client.setStatus("42", "head", "review", "success")).resolves.toBe("99");
    expect(calls).toBe(2);
    expect(waits).toEqual([250]);
  });

  it("uses the native note and discussion request contracts", async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = [];
    const responses: unknown[] = [
      [],
      { id: 10, body: "note" },
      { id: 10, body: "note" },
      [],
      { id: "thread-1", notes: [{ id: 10, body: "root" }] },
      { id: 11, body: "reply" },
      { id: "thread-1", notes: [{ id: 10, body: "root" }] },
    ];
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return Response.json(responses.shift());
    });
    const position = {
      position_type: "text" as const,
      base_sha: "base",
      start_sha: "start",
      head_sha: "head",
      old_path: "src/a.ts",
      new_path: "src/a.ts",
      new_line: 2,
    };

    await client.listNotes("group/project", 7);
    await client.createNote("group/project", 7, "note");
    await client.updateNote("group/project", 7, "10", "updated");
    await client.listDiscussions("group/project", 7);
    await client.createDiscussion("group/project", 7, "inline", position);
    await client.replyDiscussion("group/project", 7, "thread-1", "reply");
    await client.resolveDiscussion("group/project", 7, "thread-1");

    expect(requests.map(({ method, url }) => `${method} ${new URL(url).pathname}`)).toEqual([
      "GET /api/v4/projects/group%2Fproject/merge_requests/7/notes",
      "POST /api/v4/projects/group%2Fproject/merge_requests/7/notes",
      "PUT /api/v4/projects/group%2Fproject/merge_requests/7/notes/10",
      "GET /api/v4/projects/group%2Fproject/merge_requests/7/discussions",
      "POST /api/v4/projects/group%2Fproject/merge_requests/7/discussions",
      "POST /api/v4/projects/group%2Fproject/merge_requests/7/discussions/thread-1/notes",
      "PUT /api/v4/projects/group%2Fproject/merge_requests/7/discussions/thread-1",
    ]);
    expect(requests[0]?.url).toContain("per_page=100&page=1");
    expect(requests[4]?.body).toEqual({ body: "inline", position });
    expect(requests[6]?.body).toEqual({ resolved: true });
  });

  it("accepts GitLab nulls for the unused side of an inline position", async () => {
    const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async () =>
      Response.json([
        {
          id: "thread-1",
          notes: [
            {
              id: 10,
              body: "inline",
              position: {
                old_path: "src/a.ts",
                new_path: "src/a.ts",
                old_line: null,
                new_line: 2,
              },
            },
          ],
        },
      ]),
    );

    const discussions = await client.listDiscussions("group/project", 7);

    expect(discussions[0]?.notes[0]?.position).toMatchObject({
      old_path: "src/a.ts",
      new_path: "src/a.ts",
      new_line: 2,
    });
    expect(discussions[0]?.notes[0]?.position?.old_line).toBeUndefined();
  });
});

runCodeHostPaginationContract("GitLab", async () => {
  const requests: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    body: `note ${index + 1}`,
  }));
  const client = createGitLabClient({ GITLAB_TOKEN: "test-token" }, async (input) => {
    const url = String(input);
    requests.push(url);
    return Response.json(url.includes("page=2") ? [{ id: 101, body: "terminal note" }] : firstPage);
  });

  const notes = await client.listNotes("42", 7);
  return { items: notes.length, pages: requests.length };
});

const mergeRequest = {
  iid: 7,
  title: "Update fixture",
  description: null,
  web_url: "https://gitlab.com/group/project/-/merge_requests/7",
  source_branch: "feature",
  target_branch: "main",
  source_project_id: 42,
  target_project_id: 42,
  sha: "head",
};
