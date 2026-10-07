import type { AutoResolveOptions, ModelProfile, ProviderProfile } from "@usepipr/sdk";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import type { AutoResolveConfig, ProviderConfig, RuntimeSettings } from "../types.js";
import { parseProviderConfig, parseRuntimeSettings } from "../types.js";
import {
  aggregateCheckSettings,
  type NormalizedAggregateCheckSettings,
  type NormalizedTaskCheckSettings,
  taskCheckSettings,
} from "./check-settings.js";
import { assertProviderCredentials } from "./provider-credentials.js";
import {
  builtinProviderIds,
  type ProviderEnvironment,
  providerEnvironments,
} from "./provider-env.js";
import { loadTypescriptConfig } from "./ts-loader.js";
import type { ConfigVersionCompatibility } from "./version-compat.js";

export type LoadRuntimeProjectOptions = {
  rootDir: string;
  configDir?: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
  typecheck?: boolean;
};

export type LoadedRuntimeProject = {
  plan: RuntimePlan;
  settings: RuntimeSettings;
  versionCompatibility: ConfigVersionCompatibility;
};

export type ValidateProjectOptions = LoadRuntimeProjectOptions;

export type InspectRuntimePlan = {
  source: string;
  models: string[];
  agents: string[];
  tasks: string[];
  events: Array<{ task: string; actions: string[] }>;
  commands: Array<{ pattern: string; task: string; permission: string }>;
  tools: string[];
  schemas: string[];
  publication: {
    maxInlineComments?: number;
    maxStoredFindings?: number;
    showHeader: boolean;
    showFooter: boolean;
    showStats: boolean;
    showProgress: boolean;
    autoResolve: {
      enabled: boolean;
      model?: string;
      synchronize: boolean;
      userReplies: {
        enabled: boolean;
        respondWhenStillValid: boolean;
        allowedActors: "author-or-write" | "write" | "any";
      };
      hasCustomInstructions: boolean;
    };
  };
  limits: NonNullable<RuntimePlan["limits"]>;
  checks: {
    aggregate: NormalizedAggregateCheckSettings;
    tasks: Array<NormalizedTaskCheckSettings & { task: string }>;
  };
};

export async function loadRuntimeProject(
  options: LoadRuntimeProjectOptions,
): Promise<LoadedRuntimeProject> {
  const loaded = await loadTypescriptConfig(options);
  assertCustomProviderIds(loaded.plan.providers, loaded.source);
  const customProviders = new Map(loaded.plan.providers.map((provider) => [provider.id, provider]));
  const providerEnvs = await providerEnvironments(
    loaded.plan.models
      .filter((model) => model.apiKey !== "local" && !customProviders.has(model.provider))
      .map((model) => model.provider),
  );
  return {
    plan: loaded.plan,
    settings: planToRuntimeSettings(loaded.plan, {
      source: loaded.source,
      providerEnvs,
      customProviders,
      env: options.env,
      requireProviderEnv: options.requireProviderEnv,
      warnings: [loaded.versionCompatibility.warning].filter(
        (warning): warning is string => warning !== undefined,
      ),
    }),
    versionCompatibility: loaded.versionCompatibility,
  };
}

export async function validateProject(
  options: ValidateProjectOptions,
): Promise<LoadedRuntimeProject> {
  return await loadRuntimeProject({ ...options, typecheck: true });
}

export function inspectRuntimePlan(plan: RuntimePlan, source: string): InspectRuntimePlan {
  const defaultModel = plan.models[0]?.id;
  const autoResolve = normalizeAutoResolveConfig(plan.publication.autoResolve, defaultModel ?? "");
  return {
    source,
    models: plan.models.map((model) => model.id),
    agents: plan.agents.map((agent) => agent.name ?? "anonymous-agent"),
    tasks: plan.tasks.map((task) => task.name),
    events: plan.changeRequestTriggers.map((trigger) => ({
      task: trigger.task.name,
      actions: [...trigger.actions],
    })),
    commands: plan.commands.map((command) => ({
      pattern: command.pattern,
      task: command.task.name,
      permission: command.permission,
    })),
    tools: plan.tools.map((tool) => tool.name),
    schemas: ["core/pr-review", "core/inline-findings", "core/summary"],
    publication: {
      ...(plan.publication.maxInlineComments === undefined
        ? {}
        : { maxInlineComments: plan.publication.maxInlineComments }),
      ...(plan.publication.maxStoredFindings === undefined
        ? {}
        : { maxStoredFindings: plan.publication.maxStoredFindings }),
      ...publicationDisplaySettings(plan.publication),
      autoResolve: {
        enabled: autoResolve.enabled,
        ...(autoResolve.model === undefined ? {} : { model: autoResolve.model }),
        synchronize: autoResolve.synchronize,
        userReplies: autoResolve.userReplies,
        hasCustomInstructions:
          typeof plan.publication.autoResolve === "object" &&
          plan.publication.autoResolve.instructions !== undefined,
      },
    },
    limits: plan.limits ?? {},
    checks: {
      aggregate: aggregateCheckSettings(plan.checks?.aggregate),
      tasks: plan.tasks.map((task) => ({
        task: task.name,
        ...taskCheckSettings(task),
      })),
    },
  };
}

function planToRuntimeSettings(
  plan: RuntimePlan,
  options: {
    source: string;
    providerEnvs: ReadonlyMap<string, ProviderEnvironment>;
    customProviders: ReadonlyMap<string, ProviderProfile>;
    env?: NodeJS.ProcessEnv;
    requireProviderEnv?: boolean;
    warnings?: string[];
  },
): RuntimeSettings {
  const providers = plan.models.map((model) =>
    modelToProvider(model, options.providerEnvs, options.customProviders, options.source),
  );
  const defaultProvider = providers[0];
  if (!defaultProvider) {
    throw new Error(`${options.source}: at least one pipr.model() is required`);
  }
  assertUniqueProviders(providers, options.source);
  if (options.requireProviderEnv) {
    assertProviderCredentials(providers, options.env ?? process.env);
  }
  return parseRuntimeSettings({
    source: options.source,
    config: {
      defaultProvider: defaultProvider.id,
      providers,
      publication: {
        maxInlineComments: plan.publication.maxInlineComments,
        maxStoredFindings: plan.publication.maxStoredFindings,
        autoResolve: normalizeAutoResolveConfig(plan.publication.autoResolve, defaultProvider.id),
        ...publicationDisplaySettings(plan.publication),
      },
      limits: plan.limits,
    },
    warnings: options.warnings ?? [],
  });
}

/** Header, footer, stats, and progress default to shown. */
function publicationDisplaySettings(publication: RuntimePlan["publication"]) {
  return {
    showHeader: publication.showHeader ?? true,
    showFooter: publication.showFooter ?? true,
    showStats: publication.showStats ?? true,
    showProgress: publication.showProgress ?? true,
  };
}

function normalizeAutoResolveConfig(
  options: AutoResolveOptions | undefined,
  defaultProvider: string,
): AutoResolveConfig {
  if (options === false) {
    return disabledAutoResolveConfig();
  }
  return enabledAutoResolveConfig(defaultProvider, options ?? {});
}

function enabledAutoResolveConfig(
  defaultProvider: string,
  options: Exclude<AutoResolveOptions, false>,
): AutoResolveConfig {
  if (options.enabled === false && options.model) {
    throw new Error("publication.autoResolve.model cannot be set when autoResolve is disabled");
  }
  return {
    enabled: options.enabled ?? true,
    model: options.model?.id ?? defaultProvider,
    ...(options.instructions ? { instructions: options.instructions } : {}),
    synchronize: options.synchronize ?? true,
    userReplies: normalizeUserReplyAutoResolveConfig(options),
  };
}

function disabledAutoResolveConfig(): AutoResolveConfig {
  return {
    enabled: false,
    synchronize: false,
    userReplies: {
      enabled: false,
      respondWhenStillValid: true,
      allowedActors: "author-or-write",
    },
  };
}

function normalizeUserReplyAutoResolveConfig(
  options: Exclude<AutoResolveOptions, false>,
): AutoResolveConfig["userReplies"] {
  const userReplies = options.userReplies;
  if (typeof userReplies === "boolean") {
    return {
      enabled: userReplies,
      respondWhenStillValid: true,
      allowedActors: "author-or-write",
    };
  }
  return {
    enabled: userReplies?.enabled ?? true,
    respondWhenStillValid: userReplies?.respondWhenStillValid ?? true,
    allowedActors: userReplies?.allowedActors ?? "author-or-write",
  };
}

function modelToProvider(
  model: ModelProfile,
  providerEnvs: ReadonlyMap<string, ProviderEnvironment>,
  customProviders: ReadonlyMap<string, ProviderProfile>,
  source: string,
): ProviderConfig {
  const custom = customProviders.get(model.provider);
  const environment = custom
    ? { apiKeyEnv: custom.apiKey.name, companions: [], alternatives: [] }
    : providerEnvs.get(model.provider);
  return parseProviderConfig({
    id: model.id,
    provider: model.provider,
    model: model.model,
    ...modelProviderEnv(model, environment, source),
    thinking: model.thinking,
    ...(custom ? { endpoint: customModelEndpoint(custom, model.model) } : {}),
  });
}

/** The endpoint a custom provider model runs against, with any metadata the provider declares for it. */
function customModelEndpoint(provider: ProviderProfile, modelId: string) {
  const metadata = provider.models?.[modelId];
  return { api: provider.api, baseUrl: provider.baseUrl, ...(metadata ? { metadata } : {}) };
}

function assertCustomProviderIds(providers: readonly ProviderProfile[], source: string): void {
  const builtinIds = builtinProviderIds();
  for (const provider of providers) {
    if (builtinIds.has(provider.id)) {
      throw new Error(
        `${source}: pipr.provider '${provider.id}' collides with the built-in Pi provider '${provider.id}'. Choose another id.`,
      );
    }
  }
}

/**
 * A model without `apiKey` uses its provider's standard key or any fallback credential source the provider supports.
 * An explicit `apiKey` must be set, and still gets the variables the provider reads alongside its key.
 */
function modelProviderEnv(
  model: ModelProfile,
  environment: ProviderEnvironment | undefined,
  source: string,
): Pick<ProviderConfig, "apiKeyEnv" | "providerEnv" | "credentialEnv"> {
  if (model.apiKey === "local") {
    return {};
  }
  const companions = environment?.companions.length ? { providerEnv: environment.companions } : {};
  if (model.apiKey) {
    return { apiKeyEnv: model.apiKey.name, ...companions };
  }
  if (!environment) {
    throw new Error(
      `${source}: model '${model.id}' uses provider '${model.provider}', which has no standard API key environment variable. Declare the provider with pipr.provider({ id: "${model.provider}", ... }), or pass apiKey: pipr.secret({ name }) or apiKey: "local".`,
    );
  }
  return {
    apiKeyEnv: environment.apiKeyEnv,
    ...companions,
    ...(environment.alternatives.length ? { credentialEnv: environment.alternatives } : {}),
  };
}

function assertUniqueProviders(providers: ProviderConfig[], source: string): void {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) {
      throw new Error(`${source}: duplicate model id '${provider.id}'`);
    }
    seen.add(provider.id);
  }
}
