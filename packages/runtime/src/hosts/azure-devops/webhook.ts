import { z } from "zod";
import type { CodeHostWebhookProtocol } from "../webhook.js";
import { parseWebhookJson, webhookSecretsEqual } from "../webhook-shared.js";
import { createAzureDevOpsClient } from "./client.js";
import { azureOrganizationFromUrl, normalizeAzureCollectionUrl } from "./coordinates.js";

const resourceContainerSchema = z.looseObject({
  id: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

const eventSchema = z.looseObject({
  id: z.string().min(1),
  eventType: z.enum([
    "git.pullrequest.created",
    "git.pullrequest.updated",
    "ms.vss-code.git-pullrequest-comment-event",
  ]),
  subscriptionId: z.string().min(1),
  notificationId: z.union([z.number(), z.string()]).transform(String).optional(),
  resource: z.looseObject({
    repository: z
      .looseObject({ id: z.string().min(1), project: z.looseObject({ id: z.string().min(1) }) })
      .optional(),
    pullRequest: z
      .looseObject({
        repository: z.looseObject({
          id: z.string().min(1),
          project: z.looseObject({ id: z.string().min(1) }),
        }),
      })
      .optional(),
  }),
  resourceContainers: z.looseObject({
    account: resourceContainerSchema,
    collection: resourceContainerSchema,
    project: resourceContainerSchema,
  }),
});

type ExpectedRepository = {
  organization: string;
  collectionUrl: string;
  collectionId: string;
  projectId: string;
  repositoryId: string;
  subscriptionId: string;
};

export function createAzureDevOpsWebhookProtocol(): CodeHostWebhookProtocol {
  return {
    host: "azure-devops",
    async resolveExpectedRepository(env, repository) {
      const client = createAzureDevOpsClient(env);
      const resolved = await client.getRepository(repository);
      const subscriptionId = env.PIPR_AZURE_SUBSCRIPTION_ID;
      if (!subscriptionId)
        throw new Error("PIPR_AZURE_SUBSCRIPTION_ID is required for Azure DevOps webhooks");
      return {
        organization: client.organization,
        collectionUrl: client.collectionUrl,
        collectionId: await client.collectionId(),
        projectId: resolved.projectId,
        repositoryId: resolved.id,
        subscriptionId,
      };
    },
    verifySecret(headers, secret, _payload) {
      return webhookSecretsEqual(
        headers.get("X-Pipr-Webhook-Secret") ?? basicPassword(headers.get("Authorization")),
        secret,
      );
    },
    matchesExpectedRepository(payload, expected) {
      if (!isExpectedRepository(expected)) return false;
      const event = eventSchema.safeParse(parseWebhookJson(payload));
      if (!event.success) return false;
      return expectedRepositoryMatches(expected, eventRepository(event.data));
    },
    deliveryId(_headers, payload) {
      const event = eventSchema.safeParse(parseWebhookJson(payload));
      return event.success
        ? `azure-devops:${event.data.subscriptionId}:${event.data.id}:${event.data.notificationId ?? "initial"}`
        : undefined;
    },
  };
}

function isExpectedRepository(value: unknown): value is ExpectedRepository {
  return (
    typeof value === "object" &&
    value !== null &&
    "organization" in value &&
    "collectionUrl" in value &&
    "collectionId" in value &&
    "projectId" in value &&
    "repositoryId" in value &&
    "subscriptionId" in value
  );
}

function expectedRepositoryMatches(
  expected: ExpectedRepository,
  actual: Partial<ExpectedRepository>,
): boolean {
  const requiredKeys = ["collectionId", "projectId", "repositoryId", "subscriptionId"] as const;
  return (
    requiredKeys.every((key) => actual[key] === expected[key]) &&
    (actual.organization === undefined || actual.organization === expected.organization) &&
    (actual.collectionUrl === undefined || actual.collectionUrl === expected.collectionUrl)
  );
}

function eventRepository(event: z.infer<typeof eventSchema>): Partial<ExpectedRepository> {
  const repository = event.resource.repository ?? event.resource.pullRequest?.repository;
  const collectionUrl = safeCollectionUrl(
    event.resourceContainers.collection.baseUrl ?? event.resourceContainers.account.baseUrl,
  );
  const repositoryProjectId = repository?.project.id;
  const projectId =
    event.resourceContainers.project.id === repositoryProjectId ? repositoryProjectId : undefined;
  return {
    organization: collectionUrl ? azureOrganizationFromUrl(collectionUrl) : undefined,
    collectionUrl,
    collectionId: event.resourceContainers.collection.id,
    projectId,
    repositoryId: repository?.id,
    subscriptionId: event.subscriptionId,
  };
}

function safeCollectionUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return normalizeAzureCollectionUrl(value);
  } catch {
    return undefined;
  }
}

function basicPassword(value: string | null): string | null {
  if (!value?.startsWith("Basic ")) return null;
  try {
    return Buffer.from(value.slice(6), "base64").toString().split(":").slice(1).join(":") || null;
  } catch {
    return null;
  }
}
