import { z } from "zod";
import { createCodeHostHttpClient } from "../http.js";
import type { CodeHostStatusState, LoadedChangeRequest, RepositoryPermission } from "../types.js";
import { azureOrganizationFromUrl } from "./coordinates.js";

const identitySchema = z.looseObject({
  displayName: z.string().optional(),
  uniqueName: z.string().optional(),
  id: z.string().optional(),
});

const commitSchema = z.looseObject({ commitId: z.string().min(1) });
const forkRepositorySchema = z.looseObject({ remoteUrl: z.string().min(1) });

const pullRequestSchema = z.looseObject({
  pullRequestId: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  url: z.string().optional(),
  sourceRefName: z.string().min(1),
  targetRefName: z.string().min(1),
  createdBy: identitySchema.optional(),
  lastMergeSourceCommit: commitSchema,
  lastMergeTargetCommit: commitSchema,
  forkSource: z.looseObject({ repository: forkRepositorySchema }).optional(),
  repository: z.looseObject({
    id: z.string().min(1),
    name: z.string().min(1),
    url: z.string().optional(),
    project: z.looseObject({ id: z.string().min(1), name: z.string().min(1) }),
  }),
});

const repositorySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  project: z.looseObject({ id: z.string().min(1), name: z.string().min(1) }),
});

const iterationSchema = z.looseObject({
  id: z.number().int().positive(),
  sourceRefCommit: commitSchema,
});

const iterationChangeSchema = z.looseObject({
  changeTrackingId: z.number().int(),
  changeType: z.string(),
  item: z.looseObject({ path: z.string().min(1), originalPath: z.string().min(1).optional() }),
});

const threadCommentSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  parentCommentId: z.number().int().optional(),
  content: z.string().default(""),
  author: identitySchema.optional(),
  isDeleted: z.boolean().optional(),
});

const pointSchema = z.looseObject({ line: z.number().int(), offset: z.number().int() });
const threadSchema = z.looseObject({
  id: z.union([z.number(), z.string()]).transform(String),
  status: z.string().optional(),
  comments: z.array(threadCommentSchema).default([]),
  threadContext: z
    .looseObject({
      filePath: z.string().optional(),
      leftFileStart: pointSchema.nullish(),
      leftFileEnd: pointSchema.nullish(),
      rightFileStart: pointSchema.nullish(),
      rightFileEnd: pointSchema.nullish(),
    })
    .nullish(),
  pullRequestThreadContext: z
    .looseObject({
      changeTrackingId: z.number().int().optional(),
      iterationContext: z
        .looseObject({
          firstComparingIteration: z.number().int(),
          secondComparingIteration: z.number().int(),
        })
        .optional(),
    })
    .nullish(),
});

const statusSchema = z.looseObject({ id: z.union([z.number(), z.string()]).transform(String) });

export type AzureDevOpsPullRequest = z.infer<typeof pullRequestSchema>;
export type AzureDevOpsThread = z.infer<typeof threadSchema>;
export type AzureDevOpsThreadComment = z.infer<typeof threadCommentSchema>;

export type AzureDevOpsIterationChange = {
  changeTrackingId: number;
  changeType: string;
  path: string;
  originalPath?: string;
};

export type LoadedAzureDevOpsChangeRequest = LoadedChangeRequest & { iterationId: number };

export type AzureDevOpsClient = {
  organization: string;
  project: string;
  currentUser(): Promise<{ id?: string; uniqueName?: string; displayName?: string }>;
  getRepository(repository: string): Promise<{
    id: string;
    name: string;
    projectId: string;
    project: string;
  }>;
  getRepositoryPermission(
    actor: string,
    projectId: string,
    repositoryId: string,
  ): Promise<RepositoryPermission>;
  getPullRequest(repositoryId: string, changeNumber: number): Promise<AzureDevOpsPullRequest>;
  loadChange(options: {
    organization: string;
    project: string;
    repositoryId: string;
    changeNumber: number;
  }): Promise<LoadedAzureDevOpsChangeRequest>;
  listIterations(
    repositoryId: string,
    changeNumber: number,
  ): Promise<Array<{ id: number; headSha: string }>>;
  listIterationChanges(
    repositoryId: string,
    changeNumber: number,
    iterationId: number,
  ): Promise<AzureDevOpsIterationChange[]>;
  listThreads(repositoryId: string, changeNumber: number): Promise<AzureDevOpsThread[]>;
  createThread(
    repositoryId: string,
    changeNumber: number,
    body: Record<string, unknown>,
  ): Promise<AzureDevOpsThread>;
  updateComment(
    repositoryId: string,
    changeNumber: number,
    threadId: string,
    commentId: string,
    content: string,
  ): Promise<AzureDevOpsThreadComment>;
  createThreadComment(
    repositoryId: string,
    changeNumber: number,
    threadId: string,
    body: Record<string, unknown>,
  ): Promise<AzureDevOpsThreadComment>;
  updateThreadStatus(
    repositoryId: string,
    changeNumber: number,
    threadId: string,
    status: string,
  ): Promise<AzureDevOpsThread>;
  createStatus(
    repositoryId: string,
    changeNumber: number,
    body: Record<string, unknown>,
  ): Promise<string>;
};

export function createAzureDevOpsClient(
  env: NodeJS.ProcessEnv = process.env,
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response> = globalThis.fetch,
): AzureDevOpsClient {
  const organization =
    env.AZURE_DEVOPS_ORGANIZATION ?? organizationFromCollectionUri(env.SYSTEM_COLLECTIONURI);
  const project = env.AZURE_DEVOPS_PROJECT ?? env.SYSTEM_TEAMPROJECT;
  const pat = env.AZURE_DEVOPS_TOKEN;
  const bearerToken = env.AZURE_DEVOPS_BEARER_TOKEN ?? env.SYSTEM_ACCESSTOKEN;
  if (!organization)
    throw new Error("AZURE_DEVOPS_ORGANIZATION is required for Azure DevOps API calls");
  if (!project)
    throw new Error(
      "AZURE_DEVOPS_PROJECT or SYSTEM_TEAMPROJECT is required for Azure DevOps API calls",
    );
  if (!pat && !bearerToken)
    throw new Error(
      "AZURE_DEVOPS_TOKEN, AZURE_DEVOPS_BEARER_TOKEN, or SYSTEM_ACCESSTOKEN is required for Azure DevOps API calls",
    );
  const headers = pat
    ? { Authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}` }
    : { Authorization: `Bearer ${bearerToken}` };
  const api = createCodeHostHttpClient({
    baseUrl: `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_apis/`,
    headers,
    fetch,
  });
  const organizationApi = createCodeHostHttpClient({
    baseUrl: `https://dev.azure.com/${encodeURIComponent(organization)}/_apis/`,
    headers,
    fetch,
  });
  const identityApi = createCodeHostHttpClient({
    baseUrl: `https://vssps.dev.azure.com/${encodeURIComponent(organization)}/_apis/`,
    headers,
    fetch,
  });

  const pullRequestPath = (repositoryId: string, changeNumber: number) =>
    `git/repositories/${encodeURIComponent(repositoryId)}/pullRequests/${changeNumber}`;

  return {
    organization,
    project,
    async currentUser() {
      const result = await organizationApi.json(
        "connectionData?connectOptions=1&lastChangeId=-1&lastChangeId64=-1",
        z.looseObject({ authenticatedUser: identitySchema }),
      );
      return result.authenticatedUser;
    },
    async getRepository(repository) {
      const value = await api.json(
        withApiVersion(`git/repositories/${encodeURIComponent(repository)}`),
        repositorySchema,
      );
      return {
        id: value.id,
        name: value.name,
        projectId: value.project.id,
        project: value.project.name,
      };
    },
    async getRepositoryPermission(actor, projectId, repositoryId) {
      const identities = await identityApi.json(
        `identities?searchFilter=General&filterValue=${encodeURIComponent(actor)}&queryMembership=ExpandedUp&api-version=7.1`,
        collectionSchema(
          z.looseObject({
            descriptor: z.string().min(1),
            isActive: z.boolean().optional(),
            isContainer: z.boolean().optional(),
            memberOf: z.array(z.looseObject({ descriptor: z.string().min(1) })).default([]),
          }),
        ),
      );
      const candidates = identities.value.filter(
        (identity) => identity.isActive !== false && identity.isContainer !== true,
      );
      if (candidates.length !== 1) return "none";
      const identity = candidates[0];
      if (!identity) return "none";
      const descriptors = [
        identity.descriptor,
        ...identity.memberOf.map((group) => group.descriptor),
      ];
      const query = new URLSearchParams({
        token: `repoV2/${projectId}/${repositoryId}`,
        descriptors: descriptors.join(","),
        includeExtendedInfo: "true",
        recurse: "false",
        "api-version": "7.1",
      });
      const acls = await organizationApi.json(
        `accesscontrollists/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87?${query}`,
        collectionSchema(
          z.looseObject({
            acesDictionary: z.record(
              z.string(),
              z.looseObject({
                allow: z.number().int().default(0),
                deny: z.number().int().default(0),
                extendedInfo: z
                  .looseObject({
                    effectiveAllow: z.number().int().default(0),
                    effectiveDeny: z.number().int().default(0),
                  })
                  .optional(),
              }),
            ),
          }),
        ),
      );
      let allow = 0;
      let deny = 0;
      for (const acl of acls.value) {
        for (const ace of Object.values(acl.acesDictionary)) {
          allow |= ace.extendedInfo?.effectiveAllow ?? ace.allow;
          deny |= ace.extendedInfo?.effectiveDeny ?? ace.deny;
        }
      }
      return azureRepositoryPermission(allow & ~deny);
    },
    getPullRequest: (repositoryId, changeNumber) =>
      api.json(withApiVersion(pullRequestPath(repositoryId, changeNumber)), pullRequestSchema),
    async listIterations(repositoryId, changeNumber) {
      const result = await api.json(
        withApiVersion(`${pullRequestPath(repositoryId, changeNumber)}/iterations`),
        collectionSchema(iterationSchema),
      );
      return result.value.map((iteration) => ({
        id: iteration.id,
        headSha: iteration.sourceRefCommit.commitId,
      }));
    },
    async loadChange(options) {
      if (options.organization !== organization || options.project !== project) {
        throw new Error(
          "Azure DevOps client coordinates do not match its configured organization and project",
        );
      }
      const pullRequest = await this.getPullRequest(options.repositoryId, options.changeNumber);
      const iterations = await this.listIterations(options.repositoryId, options.changeNumber);
      const headSha = pullRequest.lastMergeSourceCommit.commitId;
      const iteration = iterations.findLast((candidate) => candidate.headSha === headSha);
      if (!iteration)
        throw new Error(`Azure DevOps has no pull request iteration for head ${headSha}`);
      const sourceRef = branchName(pullRequest.sourceRefName);
      const targetRef = branchName(pullRequest.targetRefName);
      return {
        repository: {
          slug: `${organization}/${pullRequest.repository.project.name}/${pullRequest.repository.name}`,
          url: `${repositoryWebUrl(
            organization,
            pullRequest.repository.project.name,
            pullRequest.repository.name,
          )}?projectId=${encodeURIComponent(pullRequest.repository.project.id)}&repositoryId=${encodeURIComponent(pullRequest.repository.id)}`,
        },
        coordinates: {
          provider: "azure-devops",
          organization,
          project: pullRequest.repository.project.name,
          projectId: pullRequest.repository.project.id,
          repositoryId: pullRequest.repository.id,
        },
        change: {
          number: pullRequest.pullRequestId,
          title: pullRequest.title,
          description: pullRequest.description ?? "",
          url: `${repositoryWebUrl(organization, pullRequest.repository.project.name, pullRequest.repository.name)}/pullrequest/${pullRequest.pullRequestId}`,
          author: pullRequest.createdBy?.uniqueName
            ? { login: pullRequest.createdBy.uniqueName }
            : undefined,
          base: { sha: pullRequest.lastMergeTargetCommit.commitId, ref: targetRef },
          head: {
            sha: headSha,
            ref: sourceRef,
            ...(pullRequest.forkSource?.repository.remoteUrl
              ? { url: pullRequest.forkSource.repository.remoteUrl }
              : {}),
          },
          ...(pullRequest.forkSource ? { isFork: true } : {}),
        },
        iterationId: iteration.id,
      };
    },
    async listIterationChanges(repositoryId, changeNumber, iterationId) {
      const changes: AzureDevOpsIterationChange[] = [];
      let skip = 0;
      let top = 2_000;
      for (;;) {
        const path = `${pullRequestPath(repositoryId, changeNumber)}/iterations/${iterationId}/changes?compareTo=0&$skip=${skip}&$top=${top}`;
        const page = await api.json(
          withApiVersion(path),
          collectionSchema(iterationChangeSchema).extend({
            nextSkip: z.number().int().nonnegative().optional(),
            nextTop: z.number().int().positive().max(2_000).optional(),
          }),
        );
        changes.push(
          ...page.value.map((change) => ({
            changeTrackingId: change.changeTrackingId,
            changeType: change.changeType,
            path: trimLeadingSlash(change.item.path),
            ...(change.item.originalPath
              ? { originalPath: trimLeadingSlash(change.item.originalPath) }
              : {}),
          })),
        );
        if (page.nextSkip === undefined) return changes;
        skip = page.nextSkip;
        top = page.nextTop ?? top;
      }
    },
    async listThreads(repositoryId, changeNumber) {
      const result = await api.json(
        withApiVersion(`${pullRequestPath(repositoryId, changeNumber)}/threads`),
        collectionSchema(threadSchema),
      );
      return result.value;
    },
    createThread: (repositoryId, changeNumber, body) =>
      api.json(
        withApiVersion(`${pullRequestPath(repositoryId, changeNumber)}/threads`),
        threadSchema,
        jsonRequest("POST", body),
      ),
    updateComment: (repositoryId, changeNumber, threadId, commentId, content) =>
      api.json(
        withApiVersion(
          `${pullRequestPath(repositoryId, changeNumber)}/threads/${encodeURIComponent(threadId)}/comments/${encodeURIComponent(commentId)}`,
        ),
        threadCommentSchema,
        jsonRequest("PATCH", { content }),
      ),
    createThreadComment: (repositoryId, changeNumber, threadId, body) =>
      api.json(
        withApiVersion(
          `${pullRequestPath(repositoryId, changeNumber)}/threads/${encodeURIComponent(threadId)}/comments`,
        ),
        threadCommentSchema,
        jsonRequest("POST", body),
      ),
    updateThreadStatus: (repositoryId, changeNumber, threadId, status) =>
      api.json(
        withApiVersion(
          `${pullRequestPath(repositoryId, changeNumber)}/threads/${encodeURIComponent(threadId)}`,
        ),
        threadSchema,
        jsonRequest("PATCH", { status }),
      ),
    async createStatus(repositoryId, changeNumber, body) {
      const status = await api.json(
        withApiVersion(`${pullRequestPath(repositoryId, changeNumber)}/statuses`),
        statusSchema,
        jsonRequest("POST", body),
      );
      return status.id;
    },
  };
}

export function azureDevOpsStatusState(state: CodeHostStatusState): string {
  switch (state) {
    case "pending":
      return "pending";
    case "success":
      return "succeeded";
    case "failure":
      return "failed";
    case "neutral":
      return "notApplicable";
  }
}

export function azureRepositoryPermission(bits: number): RepositoryPermission {
  if ((bits & 1) === 0) return "none";
  if ((bits & 8192) !== 0) return "admin";
  if ((bits & 2048) !== 0) return "maintain";
  if ((bits & 2) !== 0 && (bits & 16384) !== 0) return "write";
  if ((bits & 16384) !== 0) return "triage";
  return "read";
}

function collectionSchema<T extends z.ZodType>(item: T) {
  return z.looseObject({ count: z.number().int().nonnegative(), value: z.array(item) });
}

function withApiVersion(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}api-version=7.1`;
}

function jsonRequest(method: "POST" | "PATCH", body: Record<string, unknown>): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
}

function organizationFromCollectionUri(value: string | undefined): string | undefined {
  return value ? azureOrganizationFromUrl(value) : undefined;
}

function branchName(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

function repositoryWebUrl(organization: string, project: string, repository: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}

function trimLeadingSlash(value: string): string {
  return value.replace(/^\/+/, "");
}
