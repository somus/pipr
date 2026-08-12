export type WebhookHost =
  | "gitlab"
  | "azure-devops"
  | "bitbucket"
  | "gitea"
  | "forgejo"
  | "codeberg";

export type CodeHostWebhookProtocol = {
  host: WebhookHost;
  resolveExpectedRepository(env: NodeJS.ProcessEnv, repository: string): Promise<unknown>;
  verifySecret(headers: Headers, secret: string, payload: string): boolean;
  matchesExpectedRepository(payload: string, expected: unknown): boolean;
  deliveryId(headers: Headers, payload: string): string | undefined;
  eventName?(headers: Headers): string | undefined;
  runtimeEnv?(eventName: string | undefined): NodeJS.ProcessEnv;
};
