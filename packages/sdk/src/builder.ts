import { z } from "zod";
import { assertSupportedCommandRestCapture } from "./command-grammar.js";
import { configFactoryBrand, type InternalPiprConfigFactory } from "./internal-contract.js";
import { stripCommonIndent } from "./prompt.js";
import { renderPromptValue, serializePromptJson } from "./prompt-render.js";
import type { ReviewResult } from "./review-contract.js";
import type {
  RuntimeAgent,
  RuntimeAgentTool,
  RuntimePlan,
  RuntimeTask,
} from "./runtime-contract.js";
import {
  createAgentHandle,
  createBuiltinReadOnlyToolHandle,
  createTaskHandle,
  createToolHandle,
  runtimeAgentForHandle,
  runtimeTaskForHandle,
} from "./runtime-handles.js";
import { jsonSchema, schema, schemas } from "./schema.js";
import type { Agent, BuiltinToolCatalog } from "./types/agent.js";
import type {
  AggregateCheckOptions,
  AutoResolveOptions,
  AutoResolveUserRepliesOptions,
  ChangeRequestAction,
  ChecksOptions,
  ModelProfile,
  PiprConfigOptions,
  PublicationOptions,
} from "./types/config.js";
import { maxStoredFindingsLimit } from "./types/config.js";
import type { DiffManifestLimits, RuntimeLimits } from "./types/manifest.js";
import type { Markdown } from "./types/prompt.js";
import type {
  CommandOptions,
  CommentValue,
  DefaultReviewInput,
  PiprBuilder,
  PiprPlugin,
  Reviewer,
  ReviewerOptions,
  ReviewRecipeOptions,
  Task,
} from "./types/task.js";
import { defaultReviewActions, defaultReviewEntrypoints } from "./types/task.js";

/** Defines a synchronous pipr configuration factory. */
export function definePipr(configure: (pipr: PiprBuilder) => void): {
  readonly kind: "pipr.config-factory";
} {
  const factory = {
    kind: "pipr.config-factory",
    [configFactoryBrand]: true,
    build() {
      const builder = createBuilder();
      const result = configure(builder.api);
      if (
        typeof result === "object" &&
        result !== null &&
        typeof Reflect.get(result, "then") === "function"
      ) {
        throw new Error("definePipr configuration callback must be synchronous");
      }
      return builder.plan();
    },
  } satisfies InternalPiprConfigFactory;
  return factory;
}

/** Defines a typed pipr plugin installer. */
export function definePlugin<Handle>(setup: (builder: PiprBuilder) => Handle): PiprPlugin<Handle> {
  return { setup };
}

function createBuilder(): { api: PiprBuilder; plan(): RuntimePlan } {
  const models: ModelProfile[] = [];
  const agents: RuntimeAgent[] = [];
  const tasks: RuntimeTask[] = [];
  const changeRequestTriggers: RuntimePlan["changeRequestTriggers"] = [];
  const commands: RuntimePlan["commands"] = [];
  const tools: RuntimeAgentTool[] = [];
  const publication: RuntimePlan["publication"] = {};
  const readOnlyTool = createBuiltinReadOnlyToolHandle();
  let checks: ChecksOptions | undefined;
  let limits: RuntimeLimits | undefined;

  const api: PiprBuilder = {
    tools: {
      readOnly: [readOnlyTool.handle],
    } satisfies BuiltinToolCatalog,
    schemas,
    on: {
      changeRequest(options) {
        if (!Array.isArray(options.actions) || !options.task) {
          throw new Error("pipr.on.changeRequest requires { actions, task }");
        }
        changeRequestTriggers.push({
          actions: [...options.actions],
          task: runtimeTaskForHandle(options.task),
        });
      },
    },
    secret(options) {
      if (!options || typeof options.name !== "string") {
        throw new Error("pipr.secret requires { name }");
      }
      if (!/^[A-Z_][A-Z0-9_]*$/.test(options.name)) {
        throw new Error(`Secret '${options.name}' must be an environment variable name`);
      }
      return { kind: "pipr.secret", name: options.name };
    },
    model(options) {
      if (!options || typeof options.provider !== "string" || typeof options.model !== "string") {
        throw new Error("pipr.model requires { provider, model }");
      }
      if (!options.provider || !options.model) {
        throw new Error("pipr.model requires provider and model");
      }
      const id = options.id ?? `${options.provider}/${options.model}`;
      const profile: ModelProfile = {
        kind: "pipr.model",
        id,
        provider: options.provider,
        model: options.model,
        apiKey: options.apiKey,
        options: options.options,
      };
      models.push(profile);
      return profile;
    },
    agent(definition) {
      const agent = createAgentHandle(definition);
      agents.push(agent.record);
      return agent.handle;
    },
    task(definition) {
      if (!definition.name || typeof definition.run !== "function") {
        throw new Error("pipr.task requires { name, run }");
      }
      const task = createTaskHandle(definition);
      tasks.push(task.record);
      return task.handle;
    },
    reviewer(options) {
      return createReviewer(api, options);
    },
    review(options) {
      assertKnownReviewRecipeOptions(options);
      registerReviewRecipe(api, options);
    },
    config(options) {
      assertKnownPiprConfigOptions(options);
      mergePublicationConfig(publication, options.publication);
      checks = mergeConfigField("checks", checks, options.checks);
      limits = mergeLimits(limits, options.limits);
    },
    command(options) {
      if (typeof options.pattern !== "string" || !options.task) {
        throw new Error("pipr.command requires { pattern, task }");
      }
      const pattern = options.pattern;
      const tokens = pattern.trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) {
        throw new Error("Command pattern must not be empty");
      }
      if (tokens[0] !== "@pipr") {
        throw new Error(`Command pattern '${pattern}' must start with @pipr`);
      }
      assertSupportedCommandRestCapture(pattern);
      commands.push({
        pattern,
        permission: options.permission ?? "write",
        description: options.description,
        parse: options.parse as ((arguments_: Record<string, string>) => unknown) | undefined,
        task: runtimeTaskForHandle(options.task),
      });
    },
    use(plugin) {
      return plugin.setup(api);
    },
    tool(definition) {
      if (definition.name === "readOnly") {
        throw new Error("Tool name 'readOnly' is reserved for pipr built-in tools");
      }
      const run = definition.run;
      if (!run) {
        throw new Error(`Tool '${definition.name}' must define run`);
      }
      const tool = createToolHandle({ ...definition, run });
      tools.push(tool.record);
      return tool.handle;
    },
    schema,
    jsonSchema,
    prompt(strings, ...values) {
      let text = "";
      for (let index = 0; index < strings.length; index += 1) {
        text += strings[index] ?? "";
        if (index < values.length) {
          text += renderPromptValue(values[index]);
        }
      }
      return {
        kind: "pipr.prompt",
        value: stripCommonIndent(text).trim(),
      };
    },
    section(title, value) {
      const rendered = renderPromptValue(value);
      return {
        kind: "pipr.prompt",
        value: `## ${title}\n\n${rendered}`,
      };
    },
    json(value, options) {
      const text = serializePromptJson(value, options?.pretty !== false);
      if (options?.maxCharacters !== undefined && text.length > options.maxCharacters) {
        throw new Error(`JSON prompt value exceeded ${options.maxCharacters} characters`);
      }
      return { kind: "pipr.prompt", value: text };
    },
  };

  return {
    api,
    plan() {
      assertUnique(
        tasks.map((task) => task.name),
        "task",
      );
      assertUnique(
        commands.map((command) => command.pattern),
        "command",
      );
      assertModelIdentity(models);
      return {
        resolveAgent: runtimeAgentForHandle,
        models,
        agents,
        tasks,
        changeRequestTriggers,
        commands,
        tools,
        publication,
        checks,
        limits,
      };
    },
  };
}

function registerReviewRecipe(api: PiprBuilder, options: ReviewRecipeOptions): void {
  const id = options.id;
  const agent = options.reviewer ?? createReviewer(api, reviewRecipeReviewerOptions(options, id));

  const task = createReviewRecipeTask(api, id, agent, options);
  registerReviewRecipeEntrypoints(api, task, options);
}

const reviewRecipeOptionKeys = new Set([
  "id",
  "entrypoints",
  "comment",
  "check",
  "timeout",
  "paths",
  "reviewer",
  "name",
  "model",
  "fallbacks",
  "instructions",
  "prompt",
  "tools",
]);

const reviewRecipeEntrypointKeys = new Set(["changeRequest", "command"]);

const modelProfileConfigSchema: z.ZodType<ModelProfile> = z.custom<ModelProfile>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === "pipr.model" &&
    typeof (value as { id?: unknown }).id === "string" &&
    typeof (value as { provider?: unknown }).provider === "string" &&
    typeof (value as { model?: unknown }).model === "string",
);

const autoResolveUserRepliesOptionsSchema: z.ZodType<AutoResolveUserRepliesOptions> =
  z.strictObject({
    enabled: z.boolean().optional(),
    respondWhenStillValid: z.boolean().optional(),
    allowedActors: z.enum(["author-or-write", "write", "any"]).optional(),
  });

const autoResolveOptionsSchema: z.ZodType<AutoResolveOptions> = z.union([
  z.literal(false),
  z.strictObject({
    enabled: z.boolean().optional(),
    model: modelProfileConfigSchema.optional(),
    instructions: z.string().min(1).max(4000).optional(),
    synchronize: z.boolean().optional(),
    userReplies: z.union([z.boolean(), autoResolveUserRepliesOptionsSchema]).optional(),
  }),
]);

const publicationOptionsSchema: z.ZodType<PublicationOptions> = z.strictObject({
  maxInlineComments: z.number().int().min(0).max(50).optional(),
  maxStoredFindings: z.number().int().min(0).max(maxStoredFindingsLimit).optional(),
  autoResolve: autoResolveOptionsSchema.optional(),
  showHeader: z.boolean().optional(),
  showFooter: z.boolean().optional(),
  showStats: z.boolean().optional(),
});

const aggregateCheckOptionsSchema: z.ZodType<AggregateCheckOptions> = z.union([
  z.literal(false),
  z.strictObject({
    enabled: z.boolean().optional(),
    name: z.string().min(1).optional(),
  }),
]);

const checksOptionsSchema: z.ZodType<ChecksOptions> = z.strictObject({
  aggregate: aggregateCheckOptionsSchema.optional(),
});

const diffManifestLimitsSchema: z.ZodType<DiffManifestLimits> = z.strictObject({
  fullMaxBytes: z.number().int().positive().optional(),
  fullMaxEstimatedTokens: z.number().int().positive().optional(),
  condensedMaxBytes: z.number().int().positive().optional(),
  condensedMaxEstimatedTokens: z.number().int().positive().optional(),
  toolResponseMaxBytes: z.number().int().positive().optional(),
});

const runtimeLimitsSchema: z.ZodType<RuntimeLimits> = z.strictObject({
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
  diffManifest: diffManifestLimitsSchema.optional(),
});

const piprConfigOptionsSchema: z.ZodType<PiprConfigOptions> = z.strictObject({
  publication: publicationOptionsSchema.optional(),
  checks: checksOptionsSchema.optional(),
  limits: runtimeLimitsSchema.optional(),
});

function assertKnownReviewRecipeOptions(options: ReviewRecipeOptions): void {
  const unknownKeys = Object.keys(options).filter((key) => !reviewRecipeOptionKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`pipr.review received unsupported option fields: ${unknownKeys.join(", ")}.`);
  }

  const entrypoints = options.entrypoints;
  if (entrypoints && typeof entrypoints === "object") {
    const unknownEntrypointKeys = Object.keys(entrypoints).filter(
      (key) => !reviewRecipeEntrypointKeys.has(key),
    );
    if (unknownEntrypointKeys.length > 0) {
      throw new Error(
        `pipr.review entrypoints received unsupported fields: ${unknownEntrypointKeys.join(", ")}.`,
      );
    }
  }
}

function assertKnownPiprConfigOptions(options: unknown): asserts options is PiprConfigOptions {
  const parsed = piprConfigOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new Error(formatPiprConfigOptionsError(parsed.error));
  }
}

function formatPiprConfigOptionsError(error: z.ZodError): string {
  const unsupportedFields = firstUnsupportedConfigFields(error.issues, []);
  if (unsupportedFields) {
    return `${piprConfigLabel(unsupportedFields.path)} received unsupported option fields: ${unsupportedFields.keys.join(
      ", ",
    )}`;
  }
  return `pipr.config received invalid option value: ${z.prettifyError(error)}`;
}

function firstUnsupportedConfigFields(
  issues: readonly z.ZodIssue[],
  parentPath: readonly PropertyKey[],
): { path: PropertyKey[]; keys: string[] } | undefined {
  for (const issue of issues) {
    const path = [...parentPath, ...issue.path];
    if (issue.code === "unrecognized_keys") {
      return { path, keys: issue.keys };
    }
    if (issue.code === "invalid_union") {
      for (const branchIssues of issue.errors) {
        const unsupportedFields = firstUnsupportedConfigFields(branchIssues, path);
        if (unsupportedFields) {
          return unsupportedFields;
        }
      }
    }
  }
  return undefined;
}

function piprConfigLabel(pathSegments: PropertyKey[]): string {
  const path = pathSegments.join(".");
  return path ? `pipr.config ${path}` : "pipr.config";
}

function reviewRecipeReviewerOptions(options: ReviewerOptions, name: string): ReviewerOptions {
  if (!options.model || !options.instructions) {
    throw new Error("pipr.review requires model and instructions when reviewer is not provided");
  }
  return {
    name,
    model: options.model,
    fallbacks: options.fallbacks,
    instructions: options.instructions,
    prompt: options.prompt,
    tools: options.tools,
    timeout: options.timeout,
  };
}

function createReviewer(api: PiprBuilder, options: ReviewerOptions): Reviewer {
  return api.agent<DefaultReviewInput, ReviewResult>({
    name: options.name ?? "reviewer",
    model: options.model,
    fallbacks: options.fallbacks,
    instructions: options.instructions,
    tools: options.tools ?? api.tools.readOnly,
    output: api.schemas.review,
    timeout: options.timeout,
    prompt:
      options.prompt ??
      (() =>
        api.prompt`
          Review this change.
        `),
  });
}

function createReviewRecipeTask(
  api: PiprBuilder,
  id: string,
  agent: Agent<DefaultReviewInput, ReviewResult>,
  options: ReviewRecipeOptions,
): Task {
  return api.task({
    name: id,
    check: options.check,
    async run(context) {
      const manifest = await context.change.diffManifest({
        compressed: true,
        paths: options.paths,
      });
      if (options.paths && manifest.files.length === 0) {
        context.check.neutral("No changed files matched this review's path scope.");
        await context.comment({ main: "No changed files matched this review's path scope." });
        return;
      }
      const result = await context.pi.run(
        agent,
        { manifest, change: context.change },
        {
          timeout: options.timeout,
          paths: options.paths,
        },
      );
      const source =
        typeof options.comment === "function"
          ? await options.comment(result, {
              review: { id },
              run: context.run,
              repository: context.repository,
              change: context.change,
              platform: context.platform,
            })
          : (options.comment ?? defaultReviewComment(result));
      await context.comment(source);
    },
  });
}

function defaultReviewComment(result: ReviewResult): CommentValue {
  return {
    main: defaultReviewMarkdown(result),
    inlineFindings: result.inlineFindings,
  };
}

function defaultReviewMarkdown(result: ReviewResult): Markdown {
  const findings =
    result.inlineFindings.length === 0
      ? "No inline findings."
      : result.inlineFindings.map((finding) => `- ${finding.body}`).join("\n");
  return `## Summary\n\n${result.summary.body}\n\n## Findings\n\n${findings}`;
}

function registerReviewRecipeEntrypoints(
  api: PiprBuilder,
  task: Task,
  options: ReviewRecipeOptions,
): void {
  const changeRequest = reviewChangeRequestEntrypoint(options);
  if (changeRequest) {
    api.on.changeRequest({ actions: changeRequest, task });
  }
  const command = reviewCommandEntrypoint(options);
  if (command) {
    api.command({ pattern: command.pattern, ...command.options, task });
  }
}

function reviewChangeRequestEntrypoint(
  options: ReviewRecipeOptions,
): readonly ChangeRequestAction[] | undefined {
  const entrypoint = options.entrypoints?.changeRequest;
  return entrypoint === false ? undefined : (entrypoint ?? defaultReviewActions);
}

function reviewCommandEntrypoint(options: ReviewRecipeOptions):
  | {
      pattern: string;
      options: CommandOptions<void>;
    }
  | undefined {
  const entrypoint = options.entrypoints?.command;
  if (entrypoint === false) {
    return undefined;
  }
  if (typeof entrypoint === "object") {
    return {
      pattern: entrypoint.pattern ?? defaultReviewEntrypoints.command.pattern,
      options: {
        permission: entrypoint.permission ?? defaultReviewEntrypoints.command.permission,
        description: entrypoint.description,
      },
    };
  }
  return {
    pattern: entrypoint ?? defaultReviewEntrypoints.command.pattern,
    options: { permission: defaultReviewEntrypoints.command.permission },
  };
}

function mergePublicationConfig(
  target: RuntimePlan["publication"],
  next: PublicationOptions | undefined,
): void {
  if (!next) {
    return;
  }
  target.maxInlineComments = mergeConfigField(
    "publication.maxInlineComments",
    target.maxInlineComments,
    next.maxInlineComments,
  );
  target.maxStoredFindings = mergeConfigField(
    "publication.maxStoredFindings",
    target.maxStoredFindings,
    next.maxStoredFindings,
  );
  target.autoResolve = mergeConfigField(
    "publication.autoResolve",
    target.autoResolve,
    next.autoResolve,
  );
  target.showHeader = mergeConfigField(
    "publication.showHeader",
    target.showHeader,
    next.showHeader,
  );
  target.showFooter = mergeConfigField(
    "publication.showFooter",
    target.showFooter,
    next.showFooter,
  );
  target.showStats = mergeConfigField("publication.showStats", target.showStats, next.showStats);
}

function mergeConfigField<T>(
  name: string,
  current: T | undefined,
  next: T | undefined,
): T | undefined {
  if (next === undefined) {
    return current;
  }
  if (current !== undefined && stableJson(current) !== stableJson(next)) {
    throw new Error(`pipr.config ${name} conflicts with existing value`);
  }
  return next;
}

function mergeLimits(current: RuntimeLimits | undefined, next: RuntimeLimits | undefined) {
  if (!next) {
    return current;
  }
  assertRuntimeLimitConflicts(current, next);
  return {
    ...current,
    ...next,
    diffManifest:
      (next.diffManifest ?? current?.diffManifest)
        ? { ...current?.diffManifest, ...next.diffManifest }
        : undefined,
  };
}

function assertRuntimeLimitConflicts(
  current: RuntimeLimits | undefined,
  next: RuntimeLimits,
): void {
  const currentRecord = current as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(next)) {
    if (key === "diffManifest") {
      continue;
    }
    if (
      value !== undefined &&
      currentRecord?.[key] !== undefined &&
      stableJson(currentRecord[key]) !== stableJson(value)
    ) {
      throw new Error(`pipr.config limits.${key} conflicts with existing value`);
    }
  }
  assertDiffManifestLimitConflicts(current, next);
}

function assertDiffManifestLimitConflicts(
  current: RuntimeLimits | undefined,
  next: RuntimeLimits,
): void {
  if (current?.diffManifest && next.diffManifest) {
    for (const [key, value] of Object.entries(next.diffManifest)) {
      if (
        value !== undefined &&
        (current.diffManifest as Record<string, unknown>)[key] !== undefined &&
        (current.diffManifest as Record<string, unknown>)[key] !== value
      ) {
        throw new Error(`pipr.config limits.diffManifest.${key} conflicts with existing value`);
      }
    }
  }
}

function assertUnique(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      throw new Error(`Duplicate ${label} '${value}'`);
    }
    seen.add(value);
  }
}

function assertModelIdentity(models: ModelProfile[]): void {
  assertNoDuplicateModelConfigs(models);
  assertUniqueModelIds(models);
  assertProviderModelAliasesDisambiguated(models);
}

function assertNoDuplicateModelConfigs(models: ModelProfile[]): void {
  const effectiveConfigs = new Map<string, string>();
  for (const model of models) {
    const effectiveConfig = stableJson({
      provider: model.provider,
      model: model.model,
      apiKeyEnv: model.apiKey?.name,
      options: model.options,
    });
    const existingConfigId = effectiveConfigs.get(effectiveConfig);
    if (existingConfigId) {
      throw new Error(
        `Duplicate model config for '${model.id}'. Reuse model '${existingConfigId}' instead.`,
      );
    }
    effectiveConfigs.set(effectiveConfig, model.id);
  }
}

function assertUniqueModelIds(models: ModelProfile[]): void {
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) {
      const providerModel = `${model.provider}/${model.model}`;
      throw new Error(
        model.id === providerModel
          ? `Model '${providerModel}' is configured more than once with different options. Add an explicit id.`
          : `Duplicate model id '${model.id}'`,
      );
    }
    ids.add(model.id);
  }
}

function assertProviderModelAliasesDisambiguated(models: ModelProfile[]): void {
  const providerModels = new Map<string, string>();
  for (const model of models) {
    const providerModel = `${model.provider}/${model.model}`;
    const existingProviderModelId = providerModels.get(providerModel);
    if (
      existingProviderModelId &&
      (model.id === providerModel || existingProviderModelId === providerModel)
    ) {
      throw new Error(
        `Model '${providerModel}' is configured more than once with different options. Add an explicit id.`,
      );
    }
    providerModels.set(providerModel, model.id);
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, stableJsonValue(item)]),
    );
  }
  return value;
}
