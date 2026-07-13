import { createAzureDevOpsWebhookProtocol } from "./azure-devops/webhook.js";
import { createBitbucketWebhookProtocol } from "./bitbucket/webhook.js";
import { createGitLabWebhookProtocol } from "./gitlab/webhook.js";

export type WebhookHost = "gitlab" | "azure-devops" | "bitbucket";

export type CodeHostWebhookProtocol = {
  host: WebhookHost;
  resolveExpectedRepository(env: NodeJS.ProcessEnv, repository: string): Promise<unknown>;
  verifySecret(headers: Headers, secret: string, payload: string): boolean;
  matchesExpectedRepository(payload: string, expected: unknown): boolean;
  deliveryId(headers: Headers, payload: string): string | undefined;
  eventName?(headers: Headers): string | undefined;
  runtimeEnv?(eventName: string | undefined): NodeJS.ProcessEnv;
};

export function createCodeHostWebhookProtocol(host: WebhookHost): CodeHostWebhookProtocol {
  if (host === "gitlab") return createGitLabWebhookProtocol();
  if (host === "azure-devops") return createAzureDevOpsWebhookProtocol();
  if (host === "bitbucket") return createBitbucketWebhookProtocol();
  throw new Error(`Unsupported webhook host: ${host}`);
}
