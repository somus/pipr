import type {
  Agent,
  AgentDefinition,
  AgentTool,
  ChangeRequestAction,
  ChecksOptions,
  CommandOptions,
  CommentValue,
  DefaultReviewInput,
  Markdown,
  ModelProfile,
  PiprBuilder,
  PiprPlugin,
  PublicationOptions,
  ReviewEntrypoints,
  Reviewer,
  ReviewerOptions,
  ReviewRecipeOptions,
  RuntimeLimits,
  Task,
  ToolRunOptions,
} from "./index.js";
import { stripCommonIndent } from "./prompt.js";
import { renderPromptValue } from "./prompt-render.js";
import type { ReviewResult } from "./review-contract.js";
import type { RuntimePlan } from "./runtime-contract.js";
import { jsonSchema, schema, schemas } from "./schema.js";

const configFactoryBrand = Symbol.for("pipr.config.factory");
const builtinReadOnlyToolBrand = Symbol.for("pipr.builtin.readOnlyTool");

type InternalPiprConfigFactory = {
  readonly kind: "pipr.config-factory";
  readonly [configFactoryBrand]: true;
  build(): RuntimePlan;
};

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
  const agents: Agent[] = [];
  const tasks: Task<unknown>[] = [];
  const changeRequestTriggers: RuntimePlan["changeRequestTriggers"] = [];
  const commands: RuntimePlan["commands"] = [];
  const tools: AgentTool[] = [];
  const publication: RuntimePlan["publication"] = {};
  let checks: ChecksOptions | undefined;
  let limits: RuntimeLimits | undefined;

  const api: PiprBuilder = {
    tools: {
      readOnly: [
        {
          kind: "pipr.tool",
          name: "readOnly",
          [builtinReadOnlyToolBrand]: true,
        } as AgentTool,
      ],
    },
    schemas,
    on: {
      changeRequest(options) {
        if (!Array.isArray(options.actions) || !options.task) {
          throw new Error("pipr.on.changeRequest requires { actions, task }");
        }
        changeRequestTriggers.push({
          actions: options.actions,
          task: options.task as Task<unknown>,
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
      const agent = createAgent(definition);
      agents.push(agent);
      return agent;
    },
    task(definition) {
      if (!definition.name || typeof definition.run !== "function") {
        throw new Error("pipr.task requires { name, run }");
      }
      const task = {
        kind: "pipr.task" as const,
        name: definition.name,
        check: definition.check,
        ...(definition.local === false ? { local: false as const } : {}),
        handler: definition.run,
      };
      tasks.push(task as Task<unknown>);
      return task;
    },
    reviewer(options) {
      return createReviewer(api, options);
    },
    review(options) {
      assertKnownReviewRecipeOptions(options);
      registerReviewRecipe(api, publication, options);
    },
    config(options) {
      if (!options || typeof options !== "object") {
        throw new Error("pipr.config requires an options object");
      }
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
        task: options.task as Task<unknown>,
      });
    },
    checks(options) {
      checks = mergeConfigField("checks", checks, options);
    },
    limits(options) {
      limits = mergeLimits(limits, options);
    },
    use(plugin) {
      return plugin.setup(api);
    },
    tool(definition) {
      if (definition.name === "readOnly") {
        throw new Error("Tool name 'readOnly' is reserved for pipr built-in tools");
      }
      const execute = definition.execute;
      let run = definition.run;
      if (!run && !execute) {
        throw new Error(`Tool '${definition.name}' must define run`);
      }
      if (!run) {
        const executeTool = execute;
        if (!executeTool) {
          throw new Error(`Tool '${definition.name}' must define run`);
        }
        run = (options: ToolRunOptions<unknown>) =>
          executeTool(options.ctx, options.input as never);
      }
      const tool = {
        kind: "pipr.tool" as const,
        ...definition,
        run,
      };
      tools.push(tool);
      return tool;
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
      const text = JSON.stringify(value, null, options?.pretty === false ? 0 : 2);
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

function registerReviewRecipe(
  api: PiprBuilder,
  publication: RuntimePlan["publication"],
  options: ReviewRecipeOptions,
): void {
  const id = options.id;
  const agent = options.reviewer ?? createReviewer(api, reviewRecipeReviewerOptions(options, id));

  const task = createReviewRecipeTask(api, id, agent, options);
  registerReviewRecipeEntrypoints(api, task, options);
  updateReviewRecipePublication(publication, options);
}

const reviewRecipeOptionKeys = new Set([
  "id",
  "entrypoints",
  "inlineComments",
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
              repository: context.repository,
              change: context.change,
              platform: context.platform,
            })
          : (options.comment ?? defaultReviewComment(result, options.inlineComments !== false));
      await context.comment(source);
    },
  });
}

function defaultReviewComment(result: ReviewResult, includeInlineFindings: boolean): CommentValue {
  return {
    main: includeInlineFindings ? defaultReviewMarkdown(result) : result.summary.body,
    ...(includeInlineFindings ? { inlineFindings: result.inlineFindings } : {}),
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
): ChangeRequestAction[] | undefined {
  const entrypoint = options.entrypoints?.changeRequest;
  return entrypoint === false
    ? undefined
    : (entrypoint ?? ["opened", "updated", "reopened", "ready"]);
}

function reviewCommandEntrypoint(options: ReviewRecipeOptions):
  | {
      pattern: string;
      options: CommandOptions<unknown>;
    }
  | undefined {
  const entrypoint = options.entrypoints?.command;
  if (entrypoint === false) {
    return undefined;
  }
  if (typeof entrypoint === "object") {
    return reviewObjectCommandEntrypoint(entrypoint);
  }
  return reviewStringCommandEntrypoint(entrypoint);
}

function reviewObjectCommandEntrypoint(
  entrypoint: Exclude<ReviewEntrypoints["command"], string | false | undefined>,
) {
  return {
    pattern: entrypoint.pattern ?? "@pipr review",
    options: {
      permission: entrypoint.permission ?? "write",
      description: entrypoint.description,
    },
  };
}

function reviewStringCommandEntrypoint(entrypoint: string | undefined) {
  return {
    pattern: entrypoint ?? "@pipr review",
    options: { permission: "write" as const },
  };
}

function updateReviewRecipePublication(
  publication: RuntimePlan["publication"],
  options: ReviewRecipeOptions,
): void {
  const maxInlineComments =
    options.inlineComments === false ? 0 : (options.inlineComments?.max ?? 5);
  if (
    publication.maxInlineComments !== undefined &&
    publication.maxInlineComments !== maxInlineComments
  ) {
    throw new Error("pipr.review inlineComments settings must match across review recipes");
  }
  publication.maxInlineComments = maxInlineComments;
}

function mergePublicationConfig(
  target: RuntimePlan["publication"],
  next: PublicationOptions | undefined,
): void {
  if (!next) {
    return;
  }
  if (next.maxInlineComments !== undefined) {
    if (
      target.maxInlineComments !== undefined &&
      target.maxInlineComments !== next.maxInlineComments
    ) {
      throw new Error("pipr.config publication.maxInlineComments conflicts with existing value");
    }
    target.maxInlineComments = next.maxInlineComments;
  }
  if (next.autoResolve !== undefined) {
    if (
      target.autoResolve !== undefined &&
      stableJson(target.autoResolve) !== stableJson(next.autoResolve)
    ) {
      throw new Error("pipr.config publication.autoResolve conflicts with existing value");
    }
    target.autoResolve = next.autoResolve;
  }
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

function createAgent<Input, Output>(
  definition: AgentDefinition<Input, Output>,
): Agent<Input, Output> {
  return {
    kind: "pipr.agent",
    name: definition.name,
    definition,
    extend(patch) {
      return createAgent({
        ...definition,
        ...patch,
        instructions:
          patch.instructions === undefined
            ? definition.instructions
            : {
                kind: "pipr.prompt",
                value:
                  `${renderPromptValue(definition.instructions)}\n\n${renderPromptValue(patch.instructions)}`.trim(),
              },
      });
    },
  };
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

function assertSupportedCommandRestCapture(pattern: string): void {
  const parts = pattern.match(/\[[^\]]+\]|[^\s]+/g) ?? [];
  for (const [index, part] of parts.entries()) {
    if (part.startsWith("[") && part.endsWith("]")) {
      const optionalRest = part.slice(1, -1).trim().split(/\s+/).find(isRestCaptureToken);
      if (optionalRest) {
        throw new Error(finalRequiredRestCaptureMessage(optionalRest));
      }
      continue;
    }
    if (isRestCaptureToken(part) && index !== parts.length - 1) {
      throw new Error(finalRequiredRestCaptureMessage(part));
    }
  }
}

function isRestCaptureToken(value: string): boolean {
  return /^<[a-z0-9-]+\.\.\.>$/.test(value);
}

function finalRequiredRestCaptureMessage(token: string): string {
  return `Rest capture '${token}' must be the final required command pattern token`;
}

function assertModelIdentity(models: ModelProfile[]): void {
  const ids = new Set<string>();
  const effectiveConfigs = new Map<string, string>();
  const providerModels = new Map<string, string>();

  for (const model of models) {
    const effectiveConfig = stableJson({
      provider: model.provider,
      model: model.model,
      apiKeyEnv: model.apiKey?.name,
      options: model.options,
    });
    const providerModel = `${model.provider}/${model.model}`;

    assertUniqueModelId({ model, providerModel, effectiveConfig, ids, effectiveConfigs });
    ids.add(model.id);

    const existingConfigId = effectiveConfigs.get(effectiveConfig);
    if (existingConfigId) {
      throw new Error(
        `Duplicate model config for '${model.id}'. Reuse model '${existingConfigId}' instead.`,
      );
    }
    effectiveConfigs.set(effectiveConfig, model.id);

    assertExplicitIdForRepeatedProviderModel(model, providerModel, providerModels);
    providerModels.set(providerModel, model.id);
  }
}

function assertUniqueModelId(options: {
  model: ModelProfile;
  providerModel: string;
  effectiveConfig: string;
  ids: Set<string>;
  effectiveConfigs: Map<string, string>;
}): void {
  if (!options.ids.has(options.model.id)) {
    return;
  }
  if (options.model.id !== options.providerModel) {
    throw new Error(`Duplicate model id '${options.model.id}'`);
  }
  const existingConfigId = options.effectiveConfigs.get(options.effectiveConfig);
  if (existingConfigId) {
    throw new Error(
      `Duplicate model config for '${options.model.id}'. Reuse model '${existingConfigId}' instead.`,
    );
  }
  throw explicitModelIdError(options.providerModel);
}

function assertExplicitIdForRepeatedProviderModel(
  model: ModelProfile,
  providerModel: string,
  providerModels: Map<string, string>,
): void {
  const existingProviderModelId = providerModels.get(providerModel);
  if (
    existingProviderModelId &&
    (model.id === providerModel || existingProviderModelId === providerModel)
  ) {
    throw explicitModelIdError(providerModel);
  }
}

function explicitModelIdError(providerModel: string): Error {
  return new Error(
    `Model '${providerModel}' is configured more than once with different options. Add an explicit id.`,
  );
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
