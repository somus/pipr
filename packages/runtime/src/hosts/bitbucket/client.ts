import { z } from "zod";
import { createCodeHostHttpClient } from "../http.js";
import type { CodeHostStatusState, LoadedChangeRequest, RepositoryPermission } from "../types.js";
import { bitbucketRepositorySchema } from "./schema.js";

const userSchema = z.looseObject({
  uuid: z.string().optional(),
  nickname: z.string().optional(),
  display_name: z.string().optional(),
});
const endpointSchema = z.looseObject({
  branch: z.looseObject({ name: z.string().min(1) }),
  commit: z.looseObject({ hash: z.string().min(1) }),
  repository: bitbucketRepositorySchema,
});
const pullRequestSchema = z.looseObject({
  id: z.number().int().positive(),
  title: z.string(),
  description: z.string().default(""),
  author: userSchema.optional(),
  source: endpointSchema,
  destination: endpointSchema,
  links: z.looseObject({ html: z.looseObject({ href: z.string().url() }) }),
});
const inlineSchema = z.looseObject({
  path: z.string().optional(),
  from: z.number().int().nullable().optional(),
  to: z.number().int().nullable().optional(),
  start_from: z.number().int().nullable().optional(),
  start_to: z.number().int().nullable().optional(),
});
const commentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  content: z.looseObject({ raw: z.string().default("") }),
  user: userSchema.optional(),
  parent: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
  inline: inlineSchema.optional(),
  deleted: z.boolean().optional(),
  resolution: z.looseObject({}).optional(),
});

export type BitbucketPullRequest = z.infer<typeof pullRequestSchema>;
export type BitbucketComment = z.infer<typeof commentSchema>;

export type BitbucketClient = {
  workspace: string;
  repository: string;
  currentUser(): Promise<{ uuid?: string; nickname?: string; displayName?: string }>;
  getRepository(): Promise<{ uuid: string; slug: string; fullName: string; url: string }>;
  getRepositoryPermission(actor: string, repositoryUuid: string): Promise<RepositoryPermission>;
  getPullRequest(changeNumber: number): Promise<BitbucketPullRequest>;
  loadChange(options: {
    workspace: string;
    repository: string;
    changeNumber: number;
  }): Promise<LoadedChangeRequest>;
  listComments(changeNumber: number): Promise<BitbucketComment[]>;
  createComment(changeNumber: number, body: Record<string, unknown>): Promise<BitbucketComment>;
  updateComment(
    changeNumber: number,
    commentId: string,
    content: string,
  ): Promise<BitbucketComment>;
  replyToComment(
    changeNumber: number,
    commentId: string,
    content: string,
  ): Promise<BitbucketComment>;
  resolveComment(changeNumber: number, commentId: string): Promise<void>;
  setStatus(sha: string, key: string, body: Record<string, unknown>): Promise<string>;
};

export function createBitbucketClient(
  env: NodeJS.ProcessEnv = process.env,
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): BitbucketClient {
  const workspace = env.BITBUCKET_WORKSPACE;
  const repository = env.BITBUCKET_REPO_SLUG;
  const token = env.BITBUCKET_API_TOKEN;
  const email = env.BITBUCKET_EMAIL;
  if (!workspace) throw new Error("BITBUCKET_WORKSPACE is required for Bitbucket Cloud API calls");
  if (!repository) throw new Error("BITBUCKET_REPO_SLUG is required for Bitbucket Cloud API calls");
  if (!token || !email) throw new Error("BITBUCKET_EMAIL and BITBUCKET_API_TOKEN are required");
  const authorization = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const api = createCodeHostHttpClient({
    baseUrl: `https://api.bitbucket.org/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}/`,
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
        `repository.uuid="${repositoryUuid}" AND user.nickname="${actor.replaceAll('"', '\\"')}"`,
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
      return {
        repository: {
          slug: pullRequest.destination.repository.full_name,
          url: pullRequest.destination.repository.links.html.href,
        },
        coordinates: {
          provider: "bitbucket",
          workspace,
          repository,
          repositoryUuid: pullRequest.destination.repository.uuid,
        },
        change: {
          number: pullRequest.id,
          title: pullRequest.title,
          description: pullRequest.description,
          url: pullRequest.links.html.href,
          author: pullRequest.author?.nickname ? { login: pullRequest.author.nickname } : undefined,
          base: {
            sha: pullRequest.destination.commit.hash,
            ref: pullRequest.destination.branch.name,
            url: pullRequest.destination.repository.links.html.href,
          },
          head: {
            sha: pullRequest.source.commit.hash,
            ref: pullRequest.source.branch.name,
            url: pullRequest.source.repository.links.html.href,
          },
          isFork: pullRequest.source.repository.uuid !== pullRequest.destination.repository.uuid,
        },
      };
    },
    listComments: (id) => listAll(api, `${prPath(id)}/comments`, commentSchema),
    createComment: (id, body) =>
      api.json(`${prPath(id)}/comments`, commentSchema, jsonRequest("POST", body)),
    updateComment: (id, commentId, content) =>
      api.json(
        `${prPath(id)}/comments/${encodeURIComponent(commentId)}`,
        commentSchema,
        jsonRequest("PUT", { content: { raw: content } }),
      ),
    replyToComment: (id, commentId, content) =>
      api.json(
        `${prPath(id)}/comments`,
        commentSchema,
        jsonRequest("POST", { content: { raw: content }, parent: { id: Number(commentId) } }),
      ),
    async resolveComment(id, commentId) {
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

export function bitbucketStatusState(state: CodeHostStatusState): string {
  return state === "pending" ? "INPROGRESS" : state === "failure" ? "FAILED" : "SUCCESSFUL";
}

function pagedSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({ values: z.array(item), next: z.string().url().optional() });
}

async function listAll<T>(
  api: ReturnType<typeof createCodeHostHttpClient>,
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const values: T[] = [];
  let next: string | undefined = path;
  while (next) {
    const page: { values: T[]; next?: string } = await api.json(next, pagedSchema(schema));
    values.push(...page.values);
    next = page.next;
  }
  return values;
}

function jsonRequest(method: "POST" | "PUT", body: Record<string, unknown>): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}
