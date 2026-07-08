import type { AutoResolveOptions, ModelProfile } from "@usepipr/sdk";
import type { RuntimePlan } from "@usepipr/sdk/internal";
import type { AutoResolveConfig, ProviderConfig, RuntimeSettings } from "../types.js";
import { parseProviderConfig, parseRuntimeSettings } from "../types.js";
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
  kind: "typescript";
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
};

export async function loadRuntimeProject(
  options: LoadRuntimeProjectOptions,
): Promise<LoadedRuntimeProject> {
  const loaded = await loadTypescriptConfig(options);
  return {
    kind: "typescript",
    plan: loaded.plan,
    settings: planToRuntimeSettings(loaded.plan, {
      source: loaded.source,
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
    schemas: ["core/pr-review", "core/summary"],
  };
}

function planToRuntimeSettings(
  plan: RuntimePlan,
  options: {
    source: string;
    env?: NodeJS.ProcessEnv;
    requireProviderEnv?: boolean;
    warnings?: string[];
  },
): RuntimeSettings {
  const providers = plan.models.map(modelToProvider);
  const defaultProvider = providers[0];
  if (!defaultProvider) {
    throw new Error(`${options.source}: at least one pipr.model() is required`);
  }
  assertUniqueProviders(providers, options.source);
  assertRequiredProviderEnv(providers, options);
  return parseRuntimeSettings({
    source: options.source,
    config: {
      defaultProvider: defaultProvider.id,
      providers,
      publication: {
        maxInlineComments: plan.publication.maxInlineComments,
        autoResolve: normalizeAutoResolveConfig(plan.publication.autoResolve, defaultProvider.id),
      },
      limits: plan.limits,
    },
    warnings: options.warnings ?? [],
  });
}

function normalizeAutoResolveConfig(
  options: AutoResolveOptions | undefined,
  defaultProvider: string,
): AutoResolveConfig {
  if (options === false) {
    return disabledAutoResolveConfig();
  }
  if (!options) {
    return enabledAutoResolveConfig(defaultProvider);
  }
  return enabledAutoResolveConfig(defaultProvider, options);
}

function enabledAutoResolveConfig(
  defaultProvider: string,
  options?: Exclude<AutoResolveOptions, false>,
): AutoResolveConfig {
  if (!options) {
    return {
      enabled: true,
      model: defaultProvider,
      synchronize: true,
      userReplies: normalizeUserReplyAutoResolveConfig(undefined),
    };
  }
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
  options: Exclude<AutoResolveOptions, false> | undefined,
): AutoResolveConfig["userReplies"] {
  const userReplies = options?.userReplies;
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

function modelToProvider(model: ModelProfile): ProviderConfig {
  if (!model.apiKey) {
    throw new Error(`Model '${model.id}' must declare apiKey: pipr.secret({ name: "ENV_NAME" })`);
  }
  const thinking = model.options?.thinking;
  return parseProviderConfig({
    id: model.id,
    provider: model.provider,
    model: model.model,
    apiKeyEnv: model.apiKey.name,
    thinking: typeof thinking === "string" ? thinking : undefined,
  });
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

function assertRequiredProviderEnv(
  providers: ProviderConfig[],
  options: { env?: NodeJS.ProcessEnv; requireProviderEnv?: boolean },
): void {
  if (!options.requireProviderEnv) {
    return;
  }
  const env = options.env ?? process.env;
  const missing = providers.filter((provider) => !env[provider.apiKeyEnv]);
  if (missing.length > 0) {
    throw new Error(
      `Missing provider env vars: ${missing.map((provider) => provider.apiKeyEnv).join(", ")}`,
    );
  }
}
