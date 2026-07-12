import { createAzureDevOpsWebhookProtocol } from "./azure-devops/webhook.js";
import { createGitLabWebhookProtocol } from "./gitlab/webhook.js";

export type WebhookHost = "gitlab" | "azure-devops";

export type CodeHostWebhookProtocol = {
  host: WebhookHost;
  resolveExpectedRepository(env: NodeJS.ProcessEnv, repository: string): Promise<unknown>;
  verifySecret(headers: Headers, secret: string): boolean;
  matchesExpectedRepository(payload: string, expected: unknown): boolean;
  deliveryId(headers: Headers, payload: string): string | undefined;
};

export function createCodeHostWebhookProtocol(host: WebhookHost): CodeHostWebhookProtocol {
  return host === "gitlab" ? createGitLabWebhookProtocol() : createAzureDevOpsWebhookProtocol();
}
