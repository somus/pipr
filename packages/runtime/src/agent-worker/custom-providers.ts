import {
  type Api,
  createProvider,
  envApiKeyAuth,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { CustomModelEndpoint } from "./protocol.js";

/** A custom provider model as recorded by the worker, enough to rebuild the provider after a restart. */
export type CustomProviderModel = {
  providerId: string;
  modelId: string;
  apiKeyEnv?: string;
  endpoint: CustomModelEndpoint;
};

/** Metadata for a model the built-in catalog does not know. */
const defaultMetadata = {
  reasoning: true,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} satisfies Partial<Model<Api>>;

/**
 * Custom providers of one worker. Each registration replaces the provider with one serving every model recorded for
 * it, so registering the same model again is a no-op and new models of a provider join the existing ones.
 */
export function createCustomProviders(models: MutableModels) {
  const builtinIds = new Set(models.getProviders().map((provider) => provider.id));
  const catalog: CatalogLookup = (providerId, modelId) =>
    builtinIds.has(providerId) ? models.getModel(providerId, modelId) : undefined;
  const registered = new Map<string, Map<string, CustomProviderModel>>();
  return {
    /** Registers the model's provider, or returns why it cannot be registered. */
    register(entry: CustomProviderModel): string | undefined {
      if (builtinIds.has(entry.providerId)) {
        return `custom provider '${entry.providerId}' collides with a built-in Pi provider`;
      }
      const entries = registered.get(entry.providerId) ?? new Map<string, CustomProviderModel>();
      const first = entries.values().next().value;
      if (first && !sameEndpoint(first, entry)) entries.clear();
      entries.set(entry.modelId, entry);
      registered.set(entry.providerId, entries);
      models.setProvider(customProvider(catalog, [...entries.values()]));
      return undefined;
    },
  };
}

function sameEndpoint(left: CustomProviderModel, right: CustomProviderModel): boolean {
  return (
    left.endpoint.baseUrl === right.endpoint.baseUrl &&
    left.endpoint.api === right.endpoint.api &&
    left.apiKeyEnv === right.apiKeyEnv
  );
}

type CatalogLookup = (providerId: string, modelId: string) => Model<Api> | undefined;

function customProvider(catalog: CatalogLookup, entries: readonly CustomProviderModel[]) {
  const [first] = entries as [CustomProviderModel, ...CustomProviderModel[]];
  return createProvider({
    id: first.providerId,
    name: first.providerId,
    baseUrl: first.endpoint.baseUrl,
    auth: {
      apiKey: envApiKeyAuth(
        `${first.providerId} API key`,
        first.apiKeyEnv ? [first.apiKeyEnv] : [],
      ),
    },
    models: entries.map((entry) => customProviderModel(catalog, entry)),
    api: openAICompletionsApi(),
  });
}

/**
 * A gateway model id such as `anthropic/claude-sonnet-5-5` names a vendor and its model. When the built-in catalog
 * knows that model, its capabilities, limits, cost, and thinking levels apply; the endpoint's metadata overrides them,
 * and a declared cost replaces the catalog price, including any pricing tiers.
 */
function customProviderModel(
  catalog: CatalogLookup,
  entry: CustomProviderModel,
): Model<"openai-completions"> {
  const separator = entry.modelId.indexOf("/");
  const known =
    separator > 0
      ? catalog(entry.modelId.slice(0, separator), entry.modelId.slice(separator + 1))
      : undefined;
  const metadata = known
    ? {
        reasoning: known.reasoning,
        input: known.input,
        contextWindow: known.contextWindow,
        maxTokens: known.maxTokens,
        cost: known.cost,
        ...(known.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
      }
    : defaultMetadata;
  const { cost, ...overrides } = entry.endpoint.metadata ?? {};
  return {
    id: entry.modelId,
    name: entry.modelId,
    api: "openai-completions",
    provider: entry.providerId,
    baseUrl: entry.endpoint.baseUrl,
    ...metadata,
    ...overrides,
    ...(cost ? { cost: { cacheRead: 0, cacheWrite: 0, ...cost } } : {}),
  };
}
