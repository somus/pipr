import { createAzureDevOpsHostAdapter } from "../hosts/azure-devops/adapter.js";
import { createBitbucketHostAdapter } from "../hosts/bitbucket/adapter.js";
import { createGitHubHostAdapter } from "../hosts/github/adapter.js";
import { createGitLabHostAdapter } from "../hosts/gitlab/adapter.js";
import { resolveCodeHostId } from "../hosts/selection.js";
import type { CodeHostAdapter } from "../hosts/types.js";
import type { PiprConfig } from "../types.js";
import type { HostRunCommandDependencyOptions } from "./types.js";

export function assertTrustedHostRunProviderEnv(
  options: HostRunCommandDependencyOptions,
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
  if (host !== "github") {
    if (host === "azure-devops") {
      return createAzureDevOpsHostAdapter({ env: options.env });
    }
    if (host === "gitlab") {
      return createGitLabHostAdapter({ env: options.env });
    }
    if (host === "bitbucket") {
      return createBitbucketHostAdapter({ env: options.env });
    }
    throw new Error(`Code host adapter '${host}' is not available in this build`);
  }
  return createGitHubHostAdapter({ env: options.env });
}
