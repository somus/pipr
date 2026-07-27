import { z } from "zod";
import { parseChangeRequestEventContext } from "../../types.js";
import { positiveIntegerHostEnv, requiredHostEnv } from "../env.js";
import type { CodeHostEvent, HostEventParseOptions, LoadedChangeRequest } from "../types.js";
import { azureOrganizationFromUrl, normalizeAzureCollectionUrl } from "./coordinates.js";

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
    account: z.looseObject({
      id: z.string().min(1),
      baseUrl: z.string().url().optional(),
    }),
    collection: z.looseObject({
      id: z.string().min(1),
      baseUrl: z.string().url().optional(),
    }),
    project: z
      .looseObject({ id: z.string().min(1), baseUrl: z.string().url().optional() })
      .optional(),
  }),
});

const pullRequestResourceSchema = z.looseObject({
  pullRequestId: z.number().int().positive(),
  isDraft: z.boolean().optional(),
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
  const collectionUrl = normalizeAzureCollectionUrl(
    requiredHostEnv(options.env, "SYSTEM_COLLECTIONURI", "Azure DevOps pipeline"),
  );
  const organization = organizationFromCollectionUri(collectionUrl);
  const project = requiredHostEnv(options.env, "SYSTEM_TEAMPROJECT", "Azure DevOps pipeline");
  const repositoryId = requiredHostEnv(options.env, "BUILD_REPOSITORY_ID", "Azure DevOps pipeline");
  const changeNumber = positiveIntegerHostEnv(
    options.env,
    "SYSTEM_PULLREQUEST_PULLREQUESTID",
    "Azure DevOps pipeline",
  );
  const loaded = await loadChange(options, { organization, project, repositoryId, changeNumber });
  if (loaded.change.isDraft) return draftEvent();
  return changeRequestEvent(loaded, {
    eventName: "azure_pipeline",
    action: options.env.PIPR_CHANGE_ACTION ?? "updated",
    rawAction: options.env.PIPR_CHANGE_ACTION,
    host: collectionUrl,
    workspace: options.workspace,
  });
}

async function serviceHookEvent(options: AzureDevOpsEventParseOptions): Promise<CodeHostEvent> {
  const payload: unknown = await Bun.file(options.eventPath ?? "").json();
  const hook = serviceHookSchema.parse(payload);
  const collectionUrl = serviceHookCollectionUrl(options.env, hook.resourceContainers);
  const organization = organizationFromCollectionUri(collectionUrl);
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
          collectionUrl,
          repository.project.name,
          repository.name ?? repository.id,
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
    return pullRequestHookEvent(options, organization, collectionUrl, hook.eventType, resource);
  }
  throw new Error(`Unsupported Azure DevOps event '${hook.eventType}'`);
}

async function pullRequestHookEvent(
  options: AzureDevOpsEventParseOptions,
  organization: string,
  collectionUrl: string,
  eventType: "git.pullrequest.created" | "git.pullrequest.updated",
  resource: z.infer<typeof pullRequestResourceSchema>,
): Promise<CodeHostEvent> {
  if (resource.isDraft) return draftEvent();
  const loaded = await loadChange(options, {
    organization,
    project: resource.repository.project.name,
    repositoryId: resource.repository.id,
    changeNumber: resource.pullRequestId,
  });
  return changeRequestEvent(loaded, {
    eventName: eventType,
    action: eventType === "git.pullrequest.created" ? "opened" : "updated",
    rawAction: eventType,
    host: collectionUrl,
    workspace: options.workspace,
  });
}

function draftEvent(): CodeHostEvent {
  return { kind: "ignored", reason: "pull request is a draft" };
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

function serviceHookCollectionUrl(
  env: NodeJS.ProcessEnv,
  containers: z.infer<typeof serviceHookSchema>["resourceContainers"],
): string {
  const configured = env.SYSTEM_COLLECTIONURI || env.AZURE_DEVOPS_COLLECTION_URL;
  if (configured) return normalizeAzureCollectionUrl(configured);
  if (env.AZURE_DEVOPS_ORGANIZATION) {
    return normalizeAzureCollectionUrl(
      `https://dev.azure.com/${encodeURIComponent(env.AZURE_DEVOPS_ORGANIZATION)}`,
    );
  }
  const payloadUrl = containers.collection.baseUrl ?? containers.account.baseUrl;
  if (payloadUrl) return normalizeAzureCollectionUrl(payloadUrl);
  throw new Error("Azure DevOps service hook did not include a collection URL");
}

function azureRepositoryUrl(collectionUrl: string, project: string, repository: string): string {
  return `${collectionUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repository)}`;
}
