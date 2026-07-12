import { z } from "zod";
import type { CodeHostWebhookProtocol } from "../webhook.js";
import { parseWebhookJson, webhookSecretsEqual } from "../webhook-shared.js";
import { createAzureDevOpsClient } from "./client.js";
import { azureOrganizationFromUrl } from "./coordinates.js";

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
    account: z.looseObject({ baseUrl: z.string().url() }),
    project: z.looseObject({ id: z.string().min(1) }),
  }),
});

type ExpectedRepository = {
  organization: string;
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
        projectId: resolved.projectId,
        repositoryId: resolved.id,
        subscriptionId,
      };
    },
    verifySecret(headers, secret) {
      return webhookSecretsEqual(
        headers.get("X-Pipr-Webhook-Secret") ?? basicPassword(headers.get("Authorization")),
        secret,
      );
    },
    matchesExpectedRepository(payload, expected) {
      if (!isExpectedRepository(expected)) return false;
      const event = eventSchema.safeParse(parseWebhookJson(payload));
      if (!event.success) return false;
      const repository =
        event.data.resource.repository ?? event.data.resource.pullRequest?.repository;
      return (
        azureOrganizationFromUrl(event.data.resourceContainers.account.baseUrl) ===
          expected.organization &&
        event.data.resourceContainers.project.id === expected.projectId &&
        repository?.project.id === expected.projectId &&
        repository.id === expected.repositoryId &&
        event.data.subscriptionId === expected.subscriptionId
      );
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
    "projectId" in value &&
    "repositoryId" in value &&
    "subscriptionId" in value
  );
}

function basicPassword(value: string | null): string | null {
  if (!value?.startsWith("Basic ")) return null;
  try {
    return Buffer.from(value.slice(6), "base64").toString().split(":").slice(1).join(":") || null;
  } catch {
    return null;
  }
}
