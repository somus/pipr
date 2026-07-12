import { createGitHubHostAdapter } from "../hosts/github/adapter.js";
import type { GitHubCommandClient } from "../hosts/github/command.js";
import type { GitHubPublicationClient } from "../hosts/github/publication.js";
import { resolveCodeHostId } from "../hosts/selection.js";
import type { CodeHostAdapter } from "../hosts/types.js";
import type { PiprConfig } from "../types.js";
import type { ActionCommandDependencyOptions } from "./types.js";

export function assertTrustedActionProviderEnv(
  options: ActionCommandDependencyOptions,
  trustedConfig: PiprConfig,
): void {
  const env = options.env ?? process.env;
  const missing: string[] = [];
  for (const provider of trustedConfig.providers) {
    if (!env[provider.apiKeyEnv]) {
      missing.push(provider.apiKeyEnv);
    }
  }
  if (missing.length > 0) {
    throw new Error(`Missing provider env vars: ${missing.join(", ")}`);
  }
}

export function createActionHostAdapter(options: {
  env?: NodeJS.ProcessEnv;
  host?: string;
  hostAdapter?: CodeHostAdapter;
  githubClient?: GitHubCommandClient;
  githubPublicationClient?: GitHubPublicationClient;
}): CodeHostAdapter {
  if (options.hostAdapter) {
    return options.hostAdapter;
  }
  const injectedGitHubClient = options.githubClient ?? options.githubPublicationClient;
  const host = resolveCodeHostId({
    explicitHost: options.host ?? (injectedGitHubClient ? "github" : undefined),
    env: options.env ?? process.env,
  });
  if (host !== "github") {
    throw new Error(`Code host adapter '${host}' is not available in this build`);
  }
  return createGitHubHostAdapter({
    env: options.env,
    commandClient: options.githubClient,
    publicationClient: options.githubPublicationClient,
  });
}
