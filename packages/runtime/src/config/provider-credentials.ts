import type { ProviderConfig } from "../types.js";

/** Returns the variable to report as missing when the provider has no credential in `env`. */
export function missingProviderCredential(
  provider: ProviderConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (!provider.apiKeyEnv || env[provider.apiKeyEnv]) return undefined;
  if (provider.credentialEnv?.some((name) => env[name])) return undefined;
  return provider.apiKeyEnv;
}

/** Every variable the agent worker may need for this provider. */
export function providerEnvNames(provider: ProviderConfig): string[] {
  return [
    ...(provider.apiKeyEnv ? [provider.apiKeyEnv] : []),
    ...(provider.providerEnv ?? []),
    ...(provider.credentialEnv ?? []),
  ];
}

/** Provider variables whose values are secrets and must be redacted; ids, regions, and projects are not. */
export function providerSecretEnvNames(provider: ProviderConfig): string[] {
  return providerEnvNames(provider).filter(
    (name) => name === provider.apiKeyEnv || /KEY|TOKEN|SECRET/.test(name),
  );
}
