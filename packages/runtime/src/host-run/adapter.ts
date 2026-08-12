import { match } from "ts-pattern";
import { createAzureDevOpsHostAdapter } from "../hosts/azure-devops/adapter.js";
import { createBitbucketHostAdapter } from "../hosts/bitbucket/adapter.js";
import { createGiteaHostAdapter } from "../hosts/gitea/adapter.js";
import { createGitHubHostAdapter } from "../hosts/github/adapter.js";
import { createGitLabHostAdapter } from "../hosts/gitlab/adapter.js";
import { resolveCodeHostId } from "../hosts/selection.js";
import type { CodeHostAdapter } from "../hosts/types.js";
import type { PiprConfig } from "../types.js";

export function assertTrustedHostRunProviderEnv(
  env: NodeJS.ProcessEnv | undefined,
  trustedConfig: PiprConfig,
): void {
  const resolvedEnv = env ?? process.env;
  const missing: string[] = [];
  for (const provider of trustedConfig.providers) {
    if (provider.apiKeyEnv && !resolvedEnv[provider.apiKeyEnv]) {
      missing.push(provider.apiKeyEnv);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing provider env vars: ${missing.join(", ")}`);
  }
}

export function createHostRunAdapter(options: {
  env?: NodeJS.ProcessEnv;
  host?: string;
  hostAdapter?: CodeHostAdapter;
}): CodeHostAdapter {
  if (options.hostAdapter) {
    return options.hostAdapter;
  }
  const host = resolveCodeHostId({
    explicitHost: options.host,
    env: options.env ?? process.env,
  });
  return match(host)
    .with("github", () => createGitHubHostAdapter({ env: options.env }))
    .with("azure-devops", () => createAzureDevOpsHostAdapter({ env: options.env }))
    .with("gitlab", () => createGitLabHostAdapter({ env: options.env }))
    .with("bitbucket", () => createBitbucketHostAdapter({ env: options.env }))
    .with("gitea", "forgejo", "codeberg", (id) =>
      createGiteaHostAdapter({ host: id, env: options.env }),
    )
    .exhaustive();
}
