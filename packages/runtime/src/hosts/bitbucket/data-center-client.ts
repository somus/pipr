import { z } from "zod";
import { createCodeHostHttpClient } from "../http.js";
import type { RepositoryPermission } from "../types.js";
import { trustedBitbucketDataCenterBaseUrl } from "./base-url.js";
import { loadedBitbucketChange } from "./change.js";
import type { BitbucketClient, BitbucketComment, BitbucketPullRequest } from "./client.js";

const userSchema = z
  .looseObject({
    displayName: z.string(),
    name: z.string().min(1),
    slug: z.string().min(1),
  })
  .partial();
const repositorySchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  name: z.string().min(1),
  slug: z.string().min(1),
  project: z.looseObject({ key: z.string().min(1) }),
});
const refSchema = z.looseObject({
  id: z.string().min(1),
  displayId: z.string().min(1),
  latestCommit: z.string().min(1),
  repository: repositorySchema,
});
const pullRequestSchema = z.looseObject({
  id: z.number().int().positive(),
  draft: z.boolean().optional(),
  title: z.string(),
  description: z.string().default(""),
  author: z.looseObject({ user: userSchema }).optional(),
  fromRef: refSchema,
  toRef: refSchema,
  links: z.looseObject({
    self: z.array(z.looseObject({ href: z.string().url() })).min(1),
  }),
});
const pathSchema = z.union([
  z.string().min(1),
  z.looseObject({
    components: z.array(z.string()).optional(),
    parent: z.string().optional(),
    name: z.string().optional(),
  }),
]);
const anchorSchema = z
  .looseObject({
    path: pathSchema,
    srcPath: pathSchema.optional(),
    line: z.number().int().positive().optional(),
    fileType: z.enum(["FROM", "TO"]).optional(),
    multilineMarker: z
      .looseObject({
        startLine: z.number().int().positive(),
        startLineType: z.enum(["ADDED", "REMOVED", "CONTEXT"]),
      })
      .optional(),
  })
  .optional();
const dataCenterCommentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  version: z.number().int().nonnegative(),
  text: z.string().default(""),
  author: userSchema.optional(),
  parent: z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) }).optional(),
  anchor: anchorSchema,
  threadResolved: z.boolean().optional(),
  comments: z.array(z.unknown()).default([]),
});
const activitySchema = z.looseObject({
  action: z.string(),
  comment: z.unknown().optional(),
  commentAnchor: anchorSchema,
});
const userPermissionSchema = z.looseObject({
  name: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
});

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type DataCenterComment = z.infer<typeof dataCenterCommentSchema>;

export function createBitbucketDataCenterClient(
  env: NodeJS.ProcessEnv,
  fetch: Fetch,
): BitbucketClient {
  const baseUrl = trustedBitbucketDataCenterBaseUrl(env.BITBUCKET_BASE_URL);
  const workspace = required(env.BITBUCKET_PROJECT_KEY, "BITBUCKET_PROJECT_KEY");
  const repository = required(env.BITBUCKET_REPO_SLUG, "BITBUCKET_REPO_SLUG");
  const token = required(env.BITBUCKET_TOKEN, "BITBUCKET_TOKEN");
  const user = required(env.BITBUCKET_USER, "BITBUCKET_USER");
  const headers = { Authorization: `Bearer ${token}` };
  const api = createCodeHostHttpClient({
    baseUrl: `${baseUrl}rest/api/latest/`,
    headers,
    fetch,
  });
  const statusApi = createCodeHostHttpClient({
    baseUrl: `${baseUrl}rest/build-status/latest/`,
    headers,
    fetch,
  });
  const repositoryPath = `projects/${encodeURIComponent(workspace)}/repos/${encodeURIComponent(repository)}`;
  const prPath = (id: number) => `${repositoryPath}/pull-requests/${id}`;
  const getDataCenterPullRequest = (id: number) => api.json(prPath(id), pullRequestSchema);
  const getDataCenterComment = (id: number, commentId: string) =>
    api.json(`${prPath(id)}/comments/${encodeURIComponent(commentId)}`, dataCenterCommentSchema);

  return {
    deployment: "data-center",
    workspace,
    repository,
    async currentUser() {
      return { uuid: user, nickname: user, displayName: user };
    },
    async getRepository() {
      const value = await api.json(repositoryPath, repositorySchema);
      return {
        uuid: value.id,
        slug: value.slug,
        fullName: `${value.project.key}/${value.slug}`,
        url: repositoryWebUrl(baseUrl, value.project.key, value.slug),
      };
    },
    async getRepositoryPermission(actor) {
      const permissionToken = required(
        env.BITBUCKET_PERMISSION_TOKEN,
        "BITBUCKET_PERMISSION_TOKEN",
      );
      const permissionApi = createCodeHostHttpClient({
        baseUrl: `${baseUrl}rest/api/latest/`,
        headers: { Authorization: `Bearer ${permissionToken}` },
        fetch,
      });
      for (const [native, permission] of dataCenterPermissions) {
        const query = new URLSearchParams({
          filter: actor,
          "permission.0": native,
          "permission.0.projectKey": workspace,
          "permission.0.repositorySlug": repository,
          limit: "100",
        });
        const users = await listDataCenterPage(
          permissionApi,
          `users?${query}`,
          userPermissionSchema,
        );
        if (users.some((candidate) => candidate.name === actor || candidate.slug === actor)) {
          return permission;
        }
      }
      return "none";
    },
    async getPullRequest(id) {
      return normalizePullRequest(await getDataCenterPullRequest(id), baseUrl);
    },
    async loadChange(options) {
      if (options.workspace !== workspace || options.repository !== repository) {
        throw new Error("Bitbucket client coordinates do not match the requested repository");
      }
      const pullRequest = await this.getPullRequest(options.changeNumber);
      return loadedBitbucketChange(pullRequest, workspace, repository);
    },
    async listComments(id) {
      const activities = await listDataCenterPage(
        api,
        `${prPath(id)}/activities?limit=100`,
        activitySchema,
      );
      const comments = new Map<string, DataCenterComment>();
      for (const activity of activities) {
        if (activity.action !== "COMMENTED" || activity.comment === undefined) continue;
        for (const comment of flattenDataCenterComments(activity.comment, activity.commentAnchor)) {
          comments.set(comment.id, comment);
        }
      }
      return [...comments.values()].map(normalizeComment);
    },
    async createComment(id, body) {
      const request = await dataCenterCommentRequest(body, () => getDataCenterPullRequest(id));
      const value = await api.json(
        `${prPath(id)}/comments`,
        dataCenterCommentSchema,
        jsonRequest("POST", request),
      );
      return normalizeComment(value);
    },
    async updateComment(id, commentId, content) {
      const current = await getDataCenterComment(id, commentId);
      const value = await api.json(
        `${prPath(id)}/comments/${encodeURIComponent(commentId)}`,
        dataCenterCommentSchema,
        jsonRequest("PUT", { text: content, version: current.version }),
      );
      return normalizeComment(value);
    },
    async replyToComment(id, commentId, content) {
      const parentId = positiveCommentId(commentId);
      const value = await api.json(
        `${prPath(id)}/comments`,
        dataCenterCommentSchema,
        jsonRequest("POST", { text: content, parent: { id: parentId } }),
      );
      return normalizeComment(value);
    },
    async resolveComment(id, commentId) {
      positiveCommentId(commentId);
      const current = await getDataCenterComment(id, commentId);
      await api.json(
        `${prPath(id)}/comments/${encodeURIComponent(commentId)}`,
        dataCenterCommentSchema,
        jsonRequest("PUT", { version: current.version, threadResolved: true }),
      );
    },
    async setStatus(sha, key, body) {
      const { refname, ...status } = body;
      await statusApi.empty(
        `commits/${encodeURIComponent(sha)}`,
        jsonRequest("POST", {
          ...status,
          state: body.state === "STOPPED" ? "CANCELLED" : body.state,
          key,
          ...(typeof refname === "string" ? { ref: refname } : {}),
        }),
      );
      return key;
    },
  };
}

function normalizePullRequest(
  value: z.infer<typeof pullRequestSchema>,
  baseUrl: string,
): BitbucketPullRequest {
  const repository = (native: z.infer<typeof repositorySchema>) => ({
    uuid: native.id,
    name: native.name,
    slug: native.slug,
    full_name: `${native.project.key}/${native.slug}`,
    links: {
      html: { href: repositoryWebUrl(baseUrl, native.project.key, native.slug) },
    },
  });
  return {
    id: value.id,
    draft: value.draft,
    title: value.title,
    description: value.description,
    author: value.author?.user
      ? {
          uuid: value.author.user.slug ?? value.author.user.name,
          nickname: value.author.user.slug ?? value.author.user.name,
          display_name: value.author.user.displayName,
        }
      : undefined,
    source: {
      branch: { name: value.fromRef.displayId },
      commit: { hash: value.fromRef.latestCommit },
      repository: repository(value.fromRef.repository),
    },
    destination: {
      branch: { name: value.toRef.displayId },
      commit: { hash: value.toRef.latestCommit },
      repository: repository(value.toRef.repository),
    },
    links: {
      html: {
        href: pullRequestWebUrl(
          baseUrl,
          value.toRef.repository.project.key,
          value.toRef.repository.slug,
          value.id,
        ),
      },
    },
  };
}

function normalizeComment(value: DataCenterComment): BitbucketComment {
  return {
    id: value.id,
    content: { raw: value.text },
    user: normalizeCommentUser(value.author),
    parent: value.parent,
    inline: normalizeCommentInline(value.anchor),
    resolution: value.threadResolved ? {} : undefined,
  };
}

function normalizeCommentUser(author: DataCenterComment["author"]): BitbucketComment["user"] {
  const nickname = author?.slug ?? author?.name;
  return nickname ? { uuid: nickname, nickname, display_name: author?.displayName } : undefined;
}

function normalizeCommentInline(anchor: DataCenterComment["anchor"]): BitbucketComment["inline"] {
  if (!anchor || anchor.line === undefined || anchor.fileType === undefined) return undefined;
  const path = dataCenterPath(anchor.path);
  if (anchor.fileType === "TO") {
    return { path, to: anchor.line, start_to: anchor.multilineMarker?.startLine };
  }
  return {
    path,
    src_path: anchor.srcPath ? dataCenterPath(anchor.srcPath) : undefined,
    from: anchor.line,
    start_from: anchor.multilineMarker?.startLine,
  };
}

function flattenDataCenterComments(
  value: unknown,
  anchor?: DataCenterComment["anchor"],
): DataCenterComment[] {
  const comment = dataCenterCommentSchema.parse(value);
  return [
    { ...comment, anchor: anchor ?? comment.anchor },
    ...comment.comments.flatMap((child) => flattenDataCenterComments(child)),
  ];
}

async function dataCenterCommentRequest(
  body: Record<string, unknown>,
  getPullRequest: () => Promise<z.infer<typeof pullRequestSchema>>,
): Promise<Record<string, unknown>> {
  const content = z.looseObject({ raw: z.string() }).parse(body.content);
  const parent = z.looseObject({ id: z.number().int().positive() }).optional().parse(body.parent);
  const inline = z
    .looseObject({
      path: z.string().min(1),
      src_path: z.string().min(1).optional(),
      from: z.number().int().positive().optional(),
      to: z.number().int().positive().optional(),
      start_from: z.number().int().positive().optional(),
      start_to: z.number().int().positive().optional(),
    })
    .optional()
    .parse(body.inline);
  if (parent) return { text: content.raw, parent };
  if (!inline) return { text: content.raw };
  const pullRequest = await getPullRequest();
  return {
    text: content.raw,
    anchor: dataCenterAnchor(inline, pullRequest),
  };
}

function dataCenterAnchor(
  inline: {
    path: string;
    src_path?: string;
    from?: number;
    to?: number;
    start_from?: number;
    start_to?: number;
  },
  pullRequest: z.infer<typeof pullRequestSchema>,
): Record<string, unknown> {
  const right = inline.to !== undefined;
  const line = right ? inline.to : inline.from;
  if (!line) throw new Error("Bitbucket Data Center inline comment requires a line");
  const startLine = right ? inline.start_to : inline.start_from;
  const lineType = right ? "ADDED" : "REMOVED";
  return {
    diffType: "COMMIT",
    fileType: right ? "TO" : "FROM",
    fromHash: pullRequest.toRef.latestCommit,
    toHash: pullRequest.fromRef.latestCommit,
    line,
    lineType,
    path: inline.path,
    ...(inline.src_path ? { srcPath: inline.src_path } : {}),
    ...(startLine ? { multilineMarker: { startLine, startLineType: lineType } } : {}),
  };
}

async function listDataCenterPage<T>(
  api: ReturnType<typeof createCodeHostHttpClient>,
  path: string,
  schema: z.ZodType<T>,
): Promise<T[]> {
  const values: T[] = [];
  let next = path;
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const page = await api.json(
      next,
      z.looseObject({
        values: z.array(schema),
        isLastPage: z.boolean(),
        nextPageStart: z.number().int().nonnegative().optional(),
      }),
    );
    values.push(...page.values);
    if (page.isLastPage) return values;
    if (page.nextPageStart === undefined) {
      throw new Error("Bitbucket Data Center page is missing nextPageStart");
    }
    const url = new URL(next, "https://pagination.invalid");
    url.searchParams.set("start", String(page.nextPageStart));
    next = `${url.pathname.replace(/^\//, "")}${url.search}`;
  }
  throw new Error("Bitbucket Data Center pagination exceeded 100 pages");
}

function repositoryWebUrl(baseUrl: string, projectKey: string, repository: string): string {
  return `${baseUrl}projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repository)}/browse`;
}

function pullRequestWebUrl(
  baseUrl: string,
  projectKey: string,
  repository: string,
  pullRequestId: number,
): string {
  return `${baseUrl}projects/${encodeURIComponent(projectKey)}/repos/${encodeURIComponent(repository)}/pull-requests/${pullRequestId}/overview`;
}

function dataCenterPath(
  value: string | { components?: string[]; parent?: string; name?: string },
): string {
  if (typeof value === "string") return value;
  if (value.components?.length) return value.components.join("/");
  return [value.parent, value.name].filter(Boolean).join("/");
}

function positiveCommentId(value: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Bitbucket comment ID must be a positive integer");
  }
  return id;
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required for Bitbucket Data Center API calls`);
  return value;
}

function jsonRequest(method: "POST" | "PUT", body: Record<string, unknown>): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const dataCenterPermissions: ReadonlyArray<
  readonly [string, Exclude<RepositoryPermission, "none">]
> = [
  ["REPO_ADMIN", "admin"],
  ["REPO_WRITE", "write"],
  ["REPO_READ", "read"],
];
