import { z } from "zod";
import type { CodeHostWebhookProtocol } from "../webhook.js";
import { parseWebhookJson, webhookSecretsEqual } from "../webhook-shared.js";
import { createGitLabClient } from "./client.js";

const projectSchema = z.looseObject({
  project: z.looseObject({
    id: z.union([z.number(), z.string()]).transform(String),
    path_with_namespace: z.string().min(1),
  }),
});

type ExpectedRepository = { id: string; path: string };

export function createGitLabWebhookProtocol(): CodeHostWebhookProtocol {
  return {
    host: "gitlab",
    resolveExpectedRepository: (env, repository) => createGitLabClient(env).getProject(repository),
    verifySecret(headers, secret, _payload) {
      return webhookSecretsEqual(headers.get("X-Gitlab-Token"), secret);
    },
    matchesExpectedRepository(payload, expected) {
      if (!isExpectedRepository(expected)) return false;
      const event = projectSchema.safeParse(parseWebhookJson(payload));
      return (
        event.success &&
        event.data.project.id === expected.id &&
        event.data.project.path_with_namespace === expected.path
      );
    },
    deliveryId(headers) {
      const id = headers.get("X-Gitlab-Webhook-UUID") ?? headers.get("X-Gitlab-Event-UUID");
      return id ? `gitlab:${id}` : undefined;
    },
  };
}

function isExpectedRepository(value: unknown): value is ExpectedRepository {
  return typeof value === "object" && value !== null && "id" in value && "path" in value;
}
