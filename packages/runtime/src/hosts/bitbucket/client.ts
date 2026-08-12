import { z } from "zod";
import { createCodeHostHttpClient } from "../http.js";
import type { CodeHostStatusState } from "../types.js";
import { loadedBitbucketChange } from "./change.js";
import { createBitbucketDataCenterClient } from "./data-center-client.js";
import { type BitbucketClient, commentSchema, pullRequestSchema, userSchema } from "./models.js";
import { bitbucketRepositorySchema } from "./schema.js";

export function createBitbucketClient(
  env: NodeJS.ProcessEnv = process.env,
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): BitbucketClient {
  if (env.BITBUCKET_BASE_URL) return createBitbucketDataCenterClient(env, fetch);
  const workspace = env.BITBUCKET_WORKSPACE;
  const repository = env.BITBUCKET_REPO_SLUG;
  const token = env.BITBUCKET_API_TOKEN;
  const email = env.BITBUCKET_EMAIL;
  if (!workspace) throw new Error("BITBUCKET_WORKSPACE is required for Bitbucket Cloud API calls");
  if (!repository) throw new Error("BITBUCKET_REPO_SLUG is required for Bitbucket Cloud API calls");
  if (!token || !email) throw new Error("BITBUCKET_EMAIL and BITBUCKET_API_TOKEN are required");
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const repositoryApiPath = `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}/`;
  const api = createCodeHostHttpClient({
    baseUrl: `https://api.bitbucket.org${repositoryApiPath}`,
    headers: { Authorization: authorization },
    fetch,
  });
  const rootApi = createCodeHostHttpClient({
    baseUrl: "https://api.bitbucket.org/2.0/",
    headers: { Authorization: authorization },
    fetch,
  });
  const prPath = (id: number) => `pullrequests/${id}`;
  return {
    deployment: "cloud",
    workspace,
    repository,
    async currentUser() {
      const value = await rootApi.json("user", userSchema);
      return { uuid: value.uuid, nickname: value.nickname, displayName: value.display_name };
    },
    async getRepository() {
      const value = await api.json("", bitbucketRepositorySchema);
      return {
        uuid: value.uuid,
        slug: value.slug,
        fullName: value.full_name,
        url: value.links.html.href,
      };
    },
    async getRepositoryPermission(actor, repositoryUuid) {
      const permissionEmail = env.BITBUCKET_PERMISSION_EMAIL;
      const permissionToken = env.BITBUCKET_PERMISSION_API_TOKEN;
      if (!permissionEmail || !permissionToken)
        throw new Error(
          "BITBUCKET_PERMISSION_EMAIL and BITBUCKET_PERMISSION_API_TOKEN are required for Bitbucket permission checks",
        );
      const permissionApi = createCodeHostHttpClient({
        baseUrl: "https://api.bitbucket.org/2.0/",
        headers: {
          Authorization: `Basic ${Buffer.from(`${permissionEmail}:${permissionToken}`).toString("base64")}`,
        },
        fetch,
      });
      const query = encodeURIComponent(
        `repository.uuid="${escapeBitbucketQueryValue(repositoryUuid)}" AND user.nickname="${escapeBitbucketQueryValue(actor)}"`,
      );
      const page = await permissionApi.json(
        `workspaces/${encodeURIComponent(workspace)}/permissions/repositories?q=${query}&pagelen=100`,
        pagedSchema(
          z.looseObject({ permission: z.enum(["read", "write", "admin"]), user: userSchema }),
        ),
      );
      const permission = page.values.find((entry) => entry.user.nickname === actor)?.permission;
      return permission ?? "none";
    },
    getPullRequest: (id) => api.json(prPath(id), pullRequestSchema),
    async loadChange(options) {
      if (options.workspace !== workspace || options.repository !== repository)
        throw new Error("Bitbucket client coordinates do not match the requested repository");
      const pullRequest = await this.getPullRequest(options.changeNumber);
      return loadedBitbucketChange(pullRequest, workspace, repository);
    },
    async listComments(id) {
      return (
        await listAll(api, `${prPath(id)}/comments`, commentSchema, repositoryApiPath)
      ).filter((comment) => !comment.deleted);
    },
    createComment: (id, body) =>
      api.json(`${prPath(id)}/comments`, commentSchema, jsonRequest("POST", body)),
    updateComment: (id, commentId, content) =>
      api.json(
        `${prPath(id)}/comments/${encodeURIComponent(commentId)}`,
        commentSchema,
        jsonRequest("PUT", { content: { raw: content } }),
      ),
    async replyToComment(id, commentId, content) {
      const parentId = positiveCommentId(commentId);
      return await api.json(
        `${prPath(id)}/comments`,
        commentSchema,
        jsonRequest("POST", { content: { raw: content }, parent: { id: parentId } }),
      );
    },
    async resolveComment(id, commentId) {
      positiveCommentId(commentId);
      await api.json(
        `${prPath(id)}/comments/${encodeURIComponent(commentId)}/resolve`,
        z.unknown(),
        { method: "POST" },
      );
    },
    async setStatus(sha, key, body) {
      const value = await api.json(
        `commit/${encodeURIComponent(sha)}/statuses/build`,
        z.looseObject({ key: z.string().default(key) }),
        jsonRequest("POST", { ...body, key }),
      );
      return value.key;
    },
  };
}

function positiveCommentId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0)
    throw new Error("Bitbucket comment ID must be a positive integer");
  return id;
}

export function bitbucketStatusState(state: CodeHostStatusState): string {
  if (state === "pending") return "INPROGRESS";
  if (state === "failure") return "FAILED";
  if (state === "neutral") return "STOPPED";
  return "SUCCESSFUL";
}

function escapeBitbucketQueryValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function pagedSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({ values: z.array(item), next: z.string().url().optional() });
}

async function listAll<T>(
  api: ReturnType<typeof createCodeHostHttpClient>,
  path: string,
  schema: z.ZodType<T>,
  allowedPathPrefix: string,
): Promise<T[]> {
  const values: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: { values: T[]; next?: string } = await api.json(next, pagedSchema(schema));
    values.push(...page.values);
    if (page.next) {
      const url = new URL(page.next);
      if (url.origin !== "https://api.bitbucket.org" || !url.pathname.startsWith(allowedPathPrefix))
        throw new Error("Bitbucket pagination URL must stay inside the configured repository API");
    }
    next = page.next;
  }
  return values;
}

function jsonRequest(method: "POST" | "PUT", body: Record<string, unknown>): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
