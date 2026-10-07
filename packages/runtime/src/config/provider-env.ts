import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

/** Environment a built-in Pi provider reads for API-key auth. */
export type ProviderEnvironment = {
  /** The standard API key variable, such as `DEEPSEEK_API_KEY`. */
  apiKeyEnv: string;
  /** Variables read together with the key, such as `CLOUDFLARE_ACCOUNT_ID`. */
  companions: string[];
  /** Other credential sources the provider falls back to when no key is set, such as `AWS_ACCESS_KEY_ID`. */
  alternatives: string[];
};

/**
 * Variables pi-ai's Bedrock provider hands to the AWS SDK credential chain; its auth check only looks for the first
 * variable of each source.
 */
const awsSdkEnv = [
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
];

/**
 * Asks a built-in Pi provider which variables its API-key auth reads. With every variable set, it reads only the key and
 * the variables it always needs; with none set, it also tries each fallback credential source. Unknown providers and
 * providers without API-key auth return undefined.
 */
export async function providerEnvironment(
  providerId: string,
): Promise<ProviderEnvironment | undefined> {
  const auth = builtinProviders().find((provider) => provider.id === providerId)?.auth.apiKey;
  if (!auth) {
    return undefined;
  }
  const probe = async (present: boolean) => {
    const requested: string[] = [];
    await auth.resolve({
      ctx: {
        env: async (name) => {
          requested.push(name);
          return present ? "set" : undefined;
        },
        fileExists: async () => false,
      },
      signal: new AbortController().signal,
    });
    return requested;
  };
  // With every variable set, the provider stops at its first credential and then reads only what it always needs.
  const [firstCredential, ...required] = await probe(true);
  const whenUnset = await probe(false);
  const apiKeyEnv = whenUnset.find((name) => name.endsWith("_API_KEY")) ?? firstCredential;
  if (!apiKeyEnv) {
    return undefined;
  }
  const alternatives = whenUnset.filter((name) => name !== apiKeyEnv && !required.includes(name));
  return {
    apiKeyEnv,
    companions: [...required, ...(alternatives.includes("AWS_ACCESS_KEY_ID") ? awsSdkEnv : [])],
    alternatives,
  };
}

/** Ids of the built-in Pi providers, which `pipr.provider` ids must not reuse. */
export function builtinProviderIds(): ReadonlySet<string> {
  return new Set(builtinProviders().map((provider) => provider.id));
}

/** Resolves the API-key environment of each provider used by the configured models. */
export async function providerEnvironments(
  providerIds: readonly string[],
): Promise<ReadonlyMap<string, ProviderEnvironment>> {
  const entries = await Promise.all(
    [...new Set(providerIds)].map(
      async (providerId) => [providerId, await providerEnvironment(providerId)] as const,
    ),
  );
  return new Map(
    entries.filter(
      (entry): entry is readonly [string, ProviderEnvironment] => entry[1] !== undefined,
    ),
  );
}
