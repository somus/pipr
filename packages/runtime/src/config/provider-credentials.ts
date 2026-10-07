import { type CaptureSinks, registerSecretValue } from "../observability/capture-sinks.js";
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

/** Throws when any provider lacks a credential in `env`. */
export function assertProviderCredentials(
  providers: readonly ProviderConfig[],
  env: NodeJS.ProcessEnv,
): void {
  const missing = providers.flatMap((provider) => missingProviderCredential(provider, env) ?? []);
  if (missing.length > 0) {
    throw new Error(`Missing provider env vars: ${missing.join(", ")}`);
  }
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

/** Registers every provider secret present in `env` with the run's redaction and capture sinks. */
export function registerProviderSecrets(
  providers: readonly ProviderConfig[],
  env: NodeJS.ProcessEnv | undefined,
  sinks: CaptureSinks,
): void {
  for (const provider of providers) {
    for (const name of providerSecretEnvNames(provider)) {
      const value = (env ?? process.env)[name];
      if (value) registerSecretValue(sinks, value);
    }
  }
}
