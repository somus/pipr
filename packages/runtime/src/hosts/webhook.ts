import { createAzureDevOpsWebhookProtocol } from "./azure-devops/webhook.js";
import { createBitbucketWebhookProtocol } from "./bitbucket/webhook.js";
import { createGiteaWebhookProtocol } from "./gitea/webhook.js";
import { createGitLabWebhookProtocol } from "./gitlab/webhook.js";
import type { WebhookHost } from "./selection.js";
import type { CodeHostWebhookProtocol } from "./webhook-types.js";

export function createCodeHostWebhookProtocol(host: WebhookHost): CodeHostWebhookProtocol {
  if (host === "gitlab") return createGitLabWebhookProtocol();
  if (host === "azure-devops") return createAzureDevOpsWebhookProtocol();
  if (host === "bitbucket") return createBitbucketWebhookProtocol();
  if (host === "gitea" || host === "forgejo" || host === "codeberg") {
    return createGiteaWebhookProtocol(host);
  }
  throw new Error(`Unsupported webhook host: ${host}`);
}
