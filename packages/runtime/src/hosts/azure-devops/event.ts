import { z } from "zod";
import { parseChangeRequestEventContext } from "../../types.js";
import { positiveIntegerHostEnv, requiredHostEnv } from "../env.js";
import type { CodeHostEvent, HostEventParseOptions, LoadedChangeRequest } from "../types.js";
import { azureOrganizationFromUrl } from "./coordinates.js";

const repositorySchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  project: z.looseObject({ id: z.string().min(1), name: z.string().min(1) }),
});

const serviceHookSchema = z.looseObject({
  id: z.string().min(1),
  eventType: z.string().min(1),
  resource: z.unknown(),
  resourceContainers: z.looseObject({
    account: z.looseObject({ baseUrl: z.string().url() }),
    project: z.looseObject({ id: z.string().min(1), baseUrl: z.string().url() }).optional(),
  }),
});

const pullRequestResourceSchema = z.looseObject({
  pullRequestId: z.number().int().positive(),
  repository: repositorySchema,
});

const commentResourceSchema = z.looseObject({
  comment: z.looseObject({
    id: z.union([z.number(), z.string()]).transform(String),
    parentCommentId: z.number().int().nonnegative().default(0),
    content: z.string(),
    author: z.looseObject({ uniqueName: z.string().min(1) }),
  }),
  pullRequest: pullRequestResourceSchema,
});

export type AzureDevOpsEventParseOptions = HostEventParseOptions & {
  loadChangeRequest?: (ref: {
    organization: string;
    project: string;
    repositoryId: string;
    changeNumber: number;
  }) => Promise<LoadedChangeRequest>;
};

export async function parseAzureDevOpsEvent(
  options: AzureDevOpsEventParseOptions,
): Promise<CodeHostEvent> {
  return options.eventPath ? await serviceHookEvent(options) : await pipelineEvent(options);
}

async function pipelineEvent(options: AzureDevOpsEventParseOptions): Promise<CodeHostEvent> {
  const organization = organizationFromCollectionUri(
    requiredHostEnv(options.env, "SYSTEM_COLLECTIONURI", "Azure DevOps pipeline"),
  );
  const project = requiredHostEnv(options.env, "SYSTEM_TEAMPROJECT", "Azure DevOps pipeline");
  const repositoryId = requiredHostEnv(options.env, "BUILD_REPOSITORY_ID", "Azure DevOps pipeline");
  const changeNumber = positiveIntegerHostEnv(
    options.env,
    "SYSTEM_PULLREQUEST_PULLREQUESTID",
    "Azure DevOps pipeline",
  );
  const loaded = await loadChange(options, { organization, project, repositoryId, changeNumber });
  return changeRequestEvent(loaded, {
    eventName: "azure_pipeline",
    action: options.env.PIPR_CHANGE_ACTION ?? "updated",
    rawAction: options.env.PIPR_CHANGE_ACTION,
    host: `https://dev.azure.com/${organization}`,
    workspace: options.workspace,
  });
}

async function serviceHookEvent(options: AzureDevOpsEventParseOptions): Promise<CodeHostEvent> {
  const payload: unknown = await Bun.file(options.eventPath ?? "").json();
  const hook = serviceHookSchema.parse(payload);
  const organization = organizationFromCollectionUri(hook.resourceContainers.account.baseUrl);
  if (hook.eventType === "ms.vss-code.git-pullrequest-comment-event") {
    const resource = commentResourceSchema.parse(hook.resource);
    const repository = resource.pullRequest.repository;
    const common = {
      eventName: hook.eventType,
      action: "created",
      rawAction: hook.eventType,
      repository: {
        slug: `${organization}/${repository.project.name}/${repository.name ?? repository.id}`,
        url: azureRepositoryUrl(
          organization,
          repository.project.name,
          repository.name ?? repository.id,
        ).concat(
          `?projectId=${encodeURIComponent(repository.project.id)}&repositoryId=${encodeURIComponent(repository.id)}`,
        ),
      },
      changeNumber: resource.pullRequest.pullRequestId,
      commentId: resource.comment.id,
      body: resource.comment.content,
      actor: resource.comment.author.uniqueName,
      workspace: options.workspace,
    };
    return resource.comment.parentCommentId > 0
      ? {
          kind: "review-comment-reply",
          reply: { ...common, parentCommentId: String(resource.comment.parentCommentId) },
        }
      : { kind: "command-comment", comment: { ...common, isChangeRequest: true } };
  }
  if (
    hook.eventType === "git.pullrequest.created" ||
    hook.eventType === "git.pullrequest.updated"
  ) {
    const resource = pullRequestResourceSchema.parse(hook.resource);
    const loaded = await loadChange(options, {
      organization,
      project: resource.repository.project.name,
      repositoryId: resource.repository.id,
      changeNumber: resource.pullRequestId,
    });
    return changeRequestEvent(loaded, {
      eventName: hook.eventType,
      action: hook.eventType === "git.pullrequest.created" ? "opened" : "updated",
      rawAction: hook.eventType,
      host: `https://dev.azure.com/${organization}`,
      workspace: options.workspace,
    });
  }
  throw new Error(`Unsupported Azure DevOps event '${hook.eventType}'`);
}

function changeRequestEvent(
  loaded: LoadedChangeRequest,
  native: {
    eventName: string;
    action?: string;
    rawAction?: string;
    host: string;
    workspace: string;
  },
): CodeHostEvent {
  return {
    kind: "change-request",
    change: parseChangeRequestEventContext({
      eventName: native.eventName,
      action: native.action,
      rawAction: native.rawAction,
      platform: { id: "azure-devops", host: native.host },
      repository: loaded.repository,
      coordinates: loaded.coordinates,
      change: loaded.change,
      workspace: native.workspace,
    }),
  };
}

async function loadChange(
  options: AzureDevOpsEventParseOptions,
  ref: { organization: string; project: string; repositoryId: string; changeNumber: number },
): Promise<LoadedChangeRequest> {
  if (!options.loadChangeRequest) {
    throw new Error("Azure DevOps pull request events require an API-backed change loader");
  }
  return await options.loadChangeRequest(ref);
}

function organizationFromCollectionUri(value: string): string {
  const organization = azureOrganizationFromUrl(value);
  if (!organization) throw new Error("Azure DevOps collection URI did not contain an organization");
  return organization;
}

function azureRepositoryUrl(organization: string, project: string, repository: string): string {
  return `https://dev.azure.com/${encodeURIComponent(organization)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}
