import { z } from "zod";
import { CodeHostHttpError, createCodeHostHttpClient } from "../http.js";
import type { CodeHostStatusState, LoadedChangeRequest, RepositoryPermission } from "../types.js";

export type GiteaFamilyHost = "gitea" | "forgejo" | "codeberg";
export type GiteaReviewComment = {
  id: string;
  body: string;
  parentId?: string;
  authorLogin?: string;
  path?: string;
  commitId?: string;
  line?: number;
  side?: "RIGHT" | "LEFT";
};
export type GiteaReviewCommentReplyResult =
  | { kind: "published"; id: string }
  | { kind: "unsupported" };

const repositorySchema = z.looseObject({
  id: z.number().int().positive(),
  full_name: z.string().min(1),
  html_url: z.string().url(),
});
const branchSchema = z.looseObject({
  ref: z.string().min(1),
  sha: z.string().min(1),
  repo: repositorySchema,
});
const pullRequestSchema = z.looseObject({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().default(""),
  html_url: z.string().url(),
  draft: z.boolean().optional(),
  user: z.looseObject({ login: z.string().min(1) }).optional(),
  base: branchSchema,
  head: branchSchema,
});
const repositoryPermissionSchema = z.looseObject({
  permission: z.enum(["none", "read", "write", "admin", "owner"]),
});
const userSchema = z.looseObject({
  id: z.number().int().positive(),
  login: z.string().min(1),
});
const commentUserSchema = z.looseObject({ login: z.string().min(1) });
const commentSchema = z
  .looseObject({
    id: z.union([z.number(), z.string()]).transform(String),
    body: z.string().default(""),
    user: commentUserSchema.optional(),
  })
  .transform((comment) => ({
    id: comment.id,
    body: comment.body,
    authorLogin: comment.user?.login,
  }));
const reviewSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  user: commentUserSchema.optional(),
});
const reviewCommentSchemaInput = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  body: z.string().default(""),
  commit_id: z.string().optional(),
  path: z.string().optional(),
  position: z.number().int().min(0).optional(),
  original_position: z.number().int().min(0).optional(),
  in_reply_to_id: z.union([z.number(), z.string()]).transform(String).optional(),
  user: commentUserSchema.optional(),
});
const reviewCommentSchema = reviewCommentSchemaInput.transform(normalizeReviewComment);
const statusSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
});

export type GiteaPullRequest = z.infer<typeof pullRequestSchema>;
export type GiteaRepository = z.infer<typeof repositorySchema>;
export type GiteaComment = z.infer<typeof commentSchema>;

function normalizeReviewComment(
  comment: z.infer<typeof reviewCommentSchemaInput>,
): GiteaReviewComment {
  const normalized: GiteaReviewComment = { id: comment.id, body: comment.body };
  if (comment.in_reply_to_id) normalized.parentId = comment.in_reply_to_id;
  if (comment.user) normalized.authorLogin = comment.user.login;
  if (comment.path) normalized.path = comment.path;
  if (comment.commit_id) normalized.commitId = comment.commit_id;
  if (comment.position && comment.position > 0) {
    normalized.line = comment.position;
    normalized.side = "RIGHT";
  } else if (comment.original_position && comment.original_position > 0) {
    normalized.line = comment.original_position;
    normalized.side = "LEFT";
  }
  return normalized;
}

export type GiteaClient = {
  host: GiteaFamilyHost;
  currentUser(): Promise<{ id: number; login: string }>;
  getRepository(owner: string, repository: string): Promise<GiteaRepository>;
  getPullRequest(
    owner: string,
    repository: string,
    changeNumber: number,
  ): Promise<GiteaPullRequest>;
  getRepositoryPermission(
    owner: string,
    repository: string,
    actor: string,
  ): Promise<RepositoryPermission>;
  listIssueComments(
    owner: string,
    repository: string,
    changeNumber: number,
  ): Promise<GiteaComment[]>;
  createIssueComment(
    owner: string,
    repository: string,
    changeNumber: number,
    body: string,
  ): Promise<GiteaComment>;
  updateIssueComment(
    owner: string,
    repository: string,
    commentId: string,
    body: string,
  ): Promise<GiteaComment>;
  listReviewComments(
    owner: string,
    repository: string,
    changeNumber: number,
  ): Promise<GiteaReviewComment[]>;
  createReviewComment(
    owner: string,
    repository: string,
    changeNumber: number,
    comment: {
      body: string;
      path: string;
      commitId: string;
      line: number;
      side: "RIGHT" | "LEFT";
    },
  ): Promise<string>;
  replyToReviewComment(
    owner: string,
    repository: string,
    changeNumber: number,
    commentId: string,
    body: string,
  ): Promise<GiteaReviewCommentReplyResult>;
  setStatus(
    owner: string,
    repository: string,
    sha: string,
    name: string,
    state: CodeHostStatusState,
    description?: string,
  ): Promise<string>;
  loadChange(options: {
    owner: string;
    repository: string;
    changeNumber: number;
  }): Promise<LoadedChangeRequest>;
};

export function createGiteaClient(
  options: { host: GiteaFamilyHost; env?: NodeJS.ProcessEnv },
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): GiteaClient {
  const env = options.env ?? process.env;
  const token = giteaToken(options.host, env);
  const api = createCodeHostHttpClient({
    baseUrl: `${giteaApiUrl(options.host, env).replace(/\/$/, "")}/`,
    headers: { Authorization: `token ${token}` },
    fetch,
  });
  return {
    host: options.host,
    currentUser: () => api.json("user", userSchema),
    getRepository: (owner, repository) =>
      api.json(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
        repositorySchema,
      ),
    getPullRequest: (owner, repository, changeNumber) =>
      api.json(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${changeNumber}`,
        pullRequestSchema,
      ),
    async getRepositoryPermission(owner, repository, actor) {
      try {
        const result = await api.json(
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/collaborators/${encodeURIComponent(actor)}/permission`,
          repositoryPermissionSchema,
        );
        return result.permission === "owner" ? "admin" : result.permission;
      } catch (error) {
        if (error instanceof CodeHostHttpError && error.status === 404) return "none";
        throw error;
      }
    },
    listIssueComments: (owner, repository, changeNumber) =>
      listAll(
        api,
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${changeNumber}/comments`,
        commentSchema,
      ),
    createIssueComment: (owner, repository, changeNumber, body) =>
      api.json(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/${changeNumber}/comments`,
        commentSchema,
        jsonRequest("POST", { body }),
      ),
    updateIssueComment: (owner, repository, commentId, body) =>
      api.json(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/issues/comments/${encodeURIComponent(commentId)}`,
        commentSchema,
        jsonRequest("PATCH", { body }),
      ),
    async listReviewComments(owner, repository, changeNumber) {
      const root = `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${changeNumber}`;
      const reviews = await listAll(api, `${root}/reviews`, reviewSchema);
      const comments = await Promise.all(
        reviews.map((review) =>
          api.json(
            `${root}/reviews/${encodeURIComponent(review.id)}/comments`,
            z.array(reviewCommentSchema),
          ),
        ),
      );
      return comments.flat();
    },
    async createReviewComment(owner, repository, changeNumber, comment) {
      const location =
        comment.side === "RIGHT" ? { new_position: comment.line } : { old_position: comment.line };
      const review = await api.json(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${changeNumber}/reviews`,
        reviewSchema,
        jsonRequest("POST", {
          event: "COMMENT",
          commit_id: comment.commitId,
          comments: [{ body: comment.body, path: comment.path, ...location }],
        }),
      );
      return review.id;
    },
    async replyToReviewComment(owner, repository, changeNumber, commentId, body) {
      try {
        const reply = await api.json(
          `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/pulls/${changeNumber}/comments/${encodeURIComponent(commentId)}/replies`,
          reviewCommentSchema,
          jsonRequest("POST", { body }),
        );
        return { kind: "published", id: reply.id };
      } catch (error) {
        if (error instanceof CodeHostHttpError && (error.status === 404 || error.status === 405)) {
          return { kind: "unsupported" };
        }
        throw error;
      }
    },
    async setStatus(owner, repository, sha, name, state, description) {
      const status = await api.json(
        `repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/statuses/${encodeURIComponent(sha)}`,
        statusSchema,
        jsonRequest("POST", {
          context: `pipr/${name}`.slice(0, 255),
          state: giteaStatusState(state),
          ...(description ? { description: description.slice(0, 255) } : {}),
        }),
      );
      return status.id;
    },
    async loadChange({ owner, repository, changeNumber }) {
      const pullRequest = await this.getPullRequest(owner, repository, changeNumber);
      return {
        repository: {
          slug: pullRequest.base.repo.full_name,
          url: pullRequest.base.repo.html_url,
        },
        coordinates: { provider: "gitea", owner, repository },
        change: {
          number: pullRequest.number,
          title: pullRequest.title,
          description: pullRequest.body,
          url: pullRequest.html_url,
          author: pullRequest.user ? { login: pullRequest.user.login } : undefined,
          base: {
            sha: pullRequest.base.sha,
            ref: pullRequest.base.ref,
            url: pullRequest.base.repo.html_url,
          },
          head: {
            sha: pullRequest.head.sha,
            ref: pullRequest.head.ref,
            url: pullRequest.head.repo.html_url,
          },
          isFork: pullRequest.base.repo.id !== pullRequest.head.repo.id,
          isDraft: pullRequest.draft,
        },
      };
    },
  };
}

function giteaToken(host: GiteaFamilyHost, env: NodeJS.ProcessEnv): string {
  const token =
    host === "gitea"
      ? env.GITEA_TOKEN
      : host === "forgejo"
        ? env.FORGEJO_TOKEN
        : (env.CODEBERG_TOKEN ?? env.FORGEJO_TOKEN);
  if (!token) {
    const name =
      host === "gitea" ? "GITEA_TOKEN" : host === "forgejo" ? "FORGEJO_TOKEN" : "CODEBERG_TOKEN";
    throw new Error(`${name} is required for ${displayName(host)} API calls`);
  }
  return token;
}

function giteaApiUrl(host: GiteaFamilyHost, env: NodeJS.ProcessEnv): string {
  if (host === "gitea") {
    return (
      env.GITEA_API_URL ??
      (env.GITEA_ACTIONS === "true" ? env.GITHUB_API_URL : undefined) ??
      serverApiUrl(env.GITEA_SERVER_URL, "Gitea")
    );
  }
  if (host === "forgejo") {
    return env.FORGEJO_API_URL ?? serverApiUrl(env.FORGEJO_SERVER_URL, "Forgejo");
  }
  return env.CODEBERG_API_URL ?? "https://codeberg.org/api/v1";
}

function serverApiUrl(serverUrl: string | undefined, provider: string): string {
  if (!serverUrl) throw new Error(`${provider.toUpperCase()}_SERVER_URL is required`);
  return `${serverUrl.replace(/\/$/, "")}/api/v1`;
}

function displayName(host: GiteaFamilyHost): string {
  return host === "gitea" ? "Gitea" : host === "forgejo" ? "Forgejo" : "Codeberg";
}

type JsonClient = ReturnType<typeof createCodeHostHttpClient>;

async function listAll<T>(api: JsonClient, path: string, schema: z.ZodType<T>): Promise<T[]> {
  const values: T[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await api.json(`${path}${separator}page=${page}&limit=50`, z.array(schema));
    values.push(...batch);
    if (batch.length < 50) return values;
  }
  throw new Error(`Gitea-compatible pagination exceeded 100 pages for ${path}`);
}

function jsonRequest(method: "POST" | "PATCH", body: Record<string, unknown>): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function giteaStatusState(state: CodeHostStatusState): string {
  return state === "neutral" ? "warning" : state;
}
