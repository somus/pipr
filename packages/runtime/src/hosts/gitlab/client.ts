import { z } from "zod";
import {
  type CodeHostHttpClientOptions,
  CodeHostHttpError,
  createCodeHostHttpClient,
} from "../http.js";
import type { CodeHostStatusState, LoadedChangeRequest, RepositoryPermission } from "../types.js";

const userSchema = z.looseObject({ id: z.number().int().positive(), username: z.string().min(1) });
const noteSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  body: z.string(),
  author: userSchema.optional(),
});
const positionSchema = z.looseObject({
  new_path: z.string().optional(),
  old_path: z.string().optional(),
  new_line: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((value) => value ?? undefined),
  old_line: z
    .number()
    .int()
    .positive()
    .nullish()
    .transform((value) => value ?? undefined),
});
const discussionNoteSchema = noteSchema.extend({
  resolvable: z.boolean().optional(),
  resolved: z.boolean().optional(),
  position: positionSchema.nullable().optional(),
});
const discussionSchema = z.looseObject({
  id: z.string().min(1),
  individual_note: z.boolean().optional(),
  notes: z.array(discussionNoteSchema),
});
const diffRefsSchema = z.looseObject({
  base_sha: z.string().min(1),
  start_sha: z.string().min(1),
  head_sha: z.string().min(1),
});
const mergeRequestResponseSchema = z.looseObject({
  iid: z.number().int().positive(),
  title: z.string().default(""),
  description: z.string().nullable().optional(),
  web_url: z.string().url().optional(),
  source_branch: z.string().min(1),
  target_branch: z.string().min(1),
  source_project_id: z.number().int().positive(),
  target_project_id: z.number().int().positive(),
  sha: z.string().min(1),
  author: userSchema.optional(),
  references: z.looseObject({ full: z.string().optional() }).optional(),
  diff_refs: diffRefsSchema.nullable().optional(),
});
const mergeRequestSchema = mergeRequestResponseSchema.extend({ diff_refs: diffRefsSchema });
const memberSchema = z.looseObject({ access_level: z.number().int().min(0) });
const statusSchema = z.looseObject({ id: z.union([z.number(), z.string()]).optional() });

export type GitLabNote = z.infer<typeof noteSchema>;
export type GitLabDiscussion = z.infer<typeof discussionSchema>;
export type GitLabMergeRequest = z.infer<typeof mergeRequestSchema>;
export type GitLabDiffRefs = GitLabMergeRequest["diff_refs"];

export type GitLabPosition = {
  position_type: "text";
  base_sha: string;
  start_sha: string;
  head_sha: string;
  old_path: string;
  new_path: string;
  old_line?: number;
  new_line?: number;
  line_range?: {
    start: { line_code: string; type: "old" | "new"; old_line?: number; new_line?: number };
    end: { line_code: string; type: "old" | "new"; old_line?: number; new_line?: number };
  };
};

export type GitLabClient = {
  getProject(project: string): Promise<{ id: string; path: string }>;
  currentUser(): Promise<{ id: number; username: string }>;
  loadChange(options: {
    projectId: string;
    projectPath: string;
    changeNumber: number;
  }): Promise<LoadedChangeRequest>;
  getMergeRequest(projectId: string, changeNumber: number): Promise<GitLabMergeRequest>;
  getRepositoryPermission(projectId: string, username: string): Promise<RepositoryPermission>;
  listNotes(projectId: string, changeNumber: number): Promise<GitLabNote[]>;
  createNote(projectId: string, changeNumber: number, body: string): Promise<GitLabNote>;
  updateNote(
    projectId: string,
    changeNumber: number,
    noteId: string,
    body: string,
  ): Promise<GitLabNote>;
  listDiscussions(projectId: string, changeNumber: number): Promise<GitLabDiscussion[]>;
  getDiscussion(
    projectId: string,
    changeNumber: number,
    discussionId: string,
  ): Promise<GitLabDiscussion>;
  findReplyParent(
    projectId: string,
    changeNumber: number,
    noteId: string,
    discussionId?: string,
  ): Promise<string | undefined>;
  createDiscussion(
    projectId: string,
    changeNumber: number,
    body: string,
    position: GitLabPosition,
  ): Promise<GitLabDiscussion>;
  replyDiscussion(
    projectId: string,
    changeNumber: number,
    discussionId: string,
    body: string,
  ): Promise<GitLabNote>;
  resolveDiscussion(projectId: string, changeNumber: number, discussionId: string): Promise<void>;
  setStatus(
    projectId: string,
    sha: string,
    name: string,
    state: CodeHostStatusState,
    description?: string,
  ): Promise<string>;
};

export function createGitLabClient(
  env: NodeJS.ProcessEnv = process.env,
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
  sleep: (milliseconds: number) => Promise<unknown> = (milliseconds) => Bun.sleep(milliseconds),
): GitLabClient {
  const token = env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN;
  if (!token) {
    throw new Error("GITLAB_TOKEN or CI_JOB_TOKEN is required for GitLab API calls");
  }
  const headers: Record<string, string> = env.GITLAB_TOKEN
    ? { "PRIVATE-TOKEN": token }
    : { "JOB-TOKEN": token };
  const clientOptions: CodeHostHttpClientOptions = {
    baseUrl: `${(env.CI_API_V4_URL ?? "https://gitlab.com/api/v4").replace(/\/$/, "")}/`,
    headers,
    fetch,
    sleep: async (milliseconds: number) => void (await sleep(milliseconds)),
  };
  const api = createCodeHostHttpClient(clientOptions);
  const statusApi = createCodeHostHttpClient({
    ...clientOptions,
    retryNonIdempotentStatuses: [409],
  });

  return {
    async getProject(project) {
      const value = await api.json(
        `projects/${encodeURIComponent(project)}`,
        z.looseObject({
          id: z.union([z.number(), z.string()]).transform(String),
          path_with_namespace: z.string().min(1),
        }),
      );
      return { id: value.id, path: value.path_with_namespace };
    },
    currentUser: () => api.json("user", userSchema),
    async loadChange(options) {
      const mergeRequest = await this.getMergeRequest(options.projectId, options.changeNumber);
      return {
        repository: {
          slug: options.projectPath,
          url: projectWebUrl(mergeRequest.web_url),
        },
        coordinates: {
          provider: "gitlab",
          projectId: String(mergeRequest.target_project_id),
          projectPath: options.projectPath,
        },
        change: {
          number: mergeRequest.iid,
          title: mergeRequest.title,
          description: mergeRequest.description ?? "",
          url: mergeRequest.web_url,
          author: mergeRequest.author ? { login: mergeRequest.author.username } : undefined,
          base: { sha: mergeRequest.diff_refs.start_sha, ref: mergeRequest.target_branch },
          head: { sha: mergeRequest.diff_refs.head_sha, ref: mergeRequest.source_branch },
          isFork: mergeRequest.source_project_id !== mergeRequest.target_project_id,
        },
      };
    },
    async getMergeRequest(projectId, changeNumber) {
      const requestPath = `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}`;
      for (let attempt = 0; ; attempt += 1) {
        const response = await api.json(requestPath, mergeRequestResponseSchema);
        const prepared = mergeRequestSchema.safeParse(response);
        if (prepared.success) return prepared.data;
        if (attempt >= 4) {
          throw new Error("GitLab merge request diff refs were not prepared after 5 attempts");
        }
        await sleep(250 * 2 ** attempt);
      }
    },
    async getRepositoryPermission(projectId, username) {
      const users = await api.json(
        `users?username=${encodeURIComponent(username)}`,
        z.array(userSchema),
      );
      const user = users.find((candidate) => candidate.username === username);
      if (!user) {
        return "none";
      }
      try {
        const member = await api.json(
          `projects/${encodeURIComponent(projectId)}/members/all/${user.id}`,
          memberSchema,
        );
        return accessLevelPermission(member.access_level);
      } catch (error) {
        if (error instanceof CodeHostHttpError && error.status === 404) {
          return "none";
        }
        throw error;
      }
    },
    listNotes: (projectId, changeNumber) =>
      paginated(
        api,
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/notes`,
        noteSchema,
      ),
    createNote: (projectId, changeNumber, body) =>
      api.json(
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/notes`,
        noteSchema,
        jsonRequest("POST", { body }),
      ),
    updateNote: (projectId, changeNumber, noteId, body) =>
      api.json(
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/notes/${encodeURIComponent(noteId)}`,
        noteSchema,
        jsonRequest("PUT", { body }),
      ),
    listDiscussions: (projectId, changeNumber) =>
      paginated(
        api,
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/discussions`,
        discussionSchema,
      ),
    getDiscussion: (projectId, changeNumber, discussionId) =>
      api.json(
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/discussions/${encodeURIComponent(discussionId)}`,
        discussionSchema,
      ),
    async findReplyParent(projectId, changeNumber, noteId, discussionId) {
      if (!discussionId) return undefined;
      const discussion = await this.getDiscussion(projectId, changeNumber, discussionId);
      const containsReply = discussion.notes.some((note) => note.id === noteId);
      if (!containsReply || discussion.notes[0]?.id === noteId) {
        return undefined;
      }
      return discussion.notes[0]?.id;
    },
    createDiscussion: (projectId, changeNumber, body, position) =>
      api.json(
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/discussions`,
        discussionSchema,
        jsonRequest("POST", { body, position }),
      ),
    replyDiscussion: (projectId, changeNumber, discussionId, body) =>
      api.json(
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/discussions/${encodeURIComponent(discussionId)}/notes`,
        noteSchema,
        jsonRequest("POST", { body }),
      ),
    async resolveDiscussion(projectId, changeNumber, discussionId) {
      await api.json(
        `projects/${encodeURIComponent(projectId)}/merge_requests/${changeNumber}/discussions/${encodeURIComponent(discussionId)}`,
        discussionSchema,
        jsonRequest("PUT", { resolved: true }),
      );
    },
    async setStatus(projectId, sha, name, state, description) {
      const status = await statusApi.json(
        `projects/${encodeURIComponent(projectId)}/statuses/${encodeURIComponent(sha)}`,
        statusSchema,
        jsonRequest("POST", {
          state: gitLabStatusState(state),
          name,
          description: boundedStatusDescription(description),
        }),
      );
      return String(status.id ?? name);
    },
  };
}

type JsonClient = ReturnType<typeof createCodeHostHttpClient>;
const MAX_PAGINATION_PAGES = 100;

async function paginated<T>(client: JsonClient, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= MAX_PAGINATION_PAGES; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await client.json(
      `${path}${separator}per_page=100&page=${page}`,
      z.array(schema),
    );
    values.push(...batch);
    if (batch.length < 100) {
      return values;
    }
  }
  throw new Error(`GitLab pagination exceeded ${MAX_PAGINATION_PAGES} pages for ${path}`);
}

function jsonRequest(method: "POST" | "PUT", body: Record<string, unknown>): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function accessLevelPermission(level: number): RepositoryPermission {
  if (level >= 50) return "admin";
  if (level >= 40) return "maintain";
  if (level >= 30) return "write";
  if (level >= 15) return "triage";
  if (level >= 10) return "read";
  return "none";
}

function boundedStatusDescription(description: string | undefined): string | undefined {
  return description && description.length > 255
    ? `${description.slice(0, 252).trimEnd()}...`
    : description;
}

function gitLabStatusState(state: CodeHostStatusState): string {
  switch (state) {
    case "pending":
      return "pending";
    case "success":
      return "success";
    case "failure":
      return "failed";
    case "neutral":
      return "skipped";
  }
}

function projectWebUrl(mergeRequestUrl: string | undefined): string | undefined {
  return mergeRequestUrl?.replace(/\/-\/merge_requests\/\d+$/, "");
}
