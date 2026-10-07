import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/**
 * Returns the environment variable a built-in Pi provider reads for its API key, such as
 * `DEEPSEEK_API_KEY`. Unknown providers and providers without API-key auth return undefined.
 */
export async function providerDefaultApiKeyEnv(providerId: string): Promise<string | undefined> {
  const auth = builtinProviders().find((provider) => provider.id === providerId)?.auth.apiKey;
  if (!auth) {
    return undefined;
  }
  const requested: string[] = [];
  await auth.resolve({
    ctx: {
      env: async (name) => {
        requested.push(name);
        return undefined;
      },
      fileExists: async () => false,
    },
    signal: new AbortController().signal,
  });
  return requested.find((name) => name.endsWith("_API_KEY")) ?? requested[0];
}

/** Resolves standard API-key environment variables for each provider used by default models. */
export async function providerDefaultApiKeyEnvs(
  providerIds: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const entries = await Promise.all(
    [...new Set(providerIds)].map(
      async (providerId) => [providerId, await providerDefaultApiKeyEnv(providerId)] as const,
    ),
  );
  return new Map(
    entries.filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
}
