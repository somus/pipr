import type { TaskContext } from "@usepipr/sdk";
import {
  isBuiltinReadOnlyTool,
  type RuntimeAgent,
  type RuntimeAgentTool,
  type RuntimePlan,
} from "@usepipr/sdk/internal";
import { uniqBy } from "lodash-es";
import { match } from "ts-pattern";
import { z } from "zod";
import { shardDiffManifestForPrompt } from "../../diff/manifest-sharding.js";
import type { DiffManifest, PiprConfig, ProviderConfig } from "../../types.js";
import { reviewResultSchemaId } from "../review.js";
import {
  type AgentRunContext,
  type AgentToolResolution,
  type PreparedAgentContext,
  renderAgentPrompt,
} from "./agent-prompt.js";
import { prepareDiffManifestContext, readReservedInputManifest } from "./diff-manifest-context.js";
import type { RetrySettings, RunReviewAgentOptions } from "./review-run-types.js";
import { schemaHasCanonicalInlineFindingsRoot } from "./review-schema.js";

const retrySettingsSchema = z.strictObject({
  invalidOutput: z.number().int().min(0),
  transientFailure: z.number().int().min(0),
});

export type AssembledReviewAgentRun = {
  prepared: PreparedAgentContext;
  prompt: string;
  providers: ProviderConfig[];
  retry: RetrySettings;
};

export type ScheduledReviewManifests = {
  kind: "review" | "inlineFindings";
  manifests: DiffManifest[];
};

export async function assembleReviewAgentRun(
  options: RunReviewAgentOptions,
): Promise<AssembledReviewAgentRun> {
  const agentTools = resolveAgentTools(options.agent, options.runtime.plan);
  const agentRunContext = createAgentRunContext(options.runtime);
  const diffManifestOptions = {
    input: options.input,
    limits: options.runtime.config.limits?.diffManifest,
    toolMode: options.toolMode ?? "read-only",
    allowOversizedCondensed: options.allowOversizedCondensedManifest,
  } as const;
  let diffManifest = prepareDiffManifestContext(diffManifestOptions);
  if (
    diffManifest?.mode === "condensed" &&
    diffManifestOptions.toolMode === "read-only" &&
    options.runtime.structuralToolsEnabled !== false &&
    options.runtime.structuralAnalysis
  ) {
    diffManifest = prepareDiffManifestContext({
      ...diffManifestOptions,
      structuralAnalysis: await options.runtime.structuralAnalysis(),
    });
  }
  const prepared: PreparedAgentContext = { agentTools, agentRunContext, diffManifest };
  const prompt = await renderAgentPrompt({ ...options, ...prepared });
  const providers = selectProviders(options.runtime, options.agent, options.runOptions);
  const retry = retrySettings(options.agent);
  return { prepared, prompt, providers, retry };
}

export async function scheduledReviewManifests(
  options: RunReviewAgentOptions,
): Promise<ScheduledReviewManifests | undefined> {
  const kind = match(options.agent.definition.output)
    .returnType<"review" | "inlineFindings" | undefined>()
    .when(
      (output) => output.id === reviewResultSchemaId,
      () => "review" as const,
    )
    .when(
      (output) => schemaHasCanonicalInlineFindingsRoot(output.jsonSchema),
      () => "inlineFindings" as const,
    )
    .otherwise(() => undefined);
  if (!kind) {
    return undefined;
  }
  const manifest = readReservedInputManifest(options.input);
  if (!manifest) {
    return undefined;
  }
  const maxShards = options.runOptions?.maxShards;
  const config =
    maxShards === undefined
      ? options.runtime.config.limits?.diffManifest
      : { ...options.runtime.config.limits?.diffManifest, maxShards };
  const manifests = await shardDiffManifestForPrompt({
    manifest,
    config,
    workspace: options.runtime.workspace,
    env: options.runtime.env,
    log: options.runtime.log,
    structuralAnalysis: options.runtime.structuralAnalysis,
  });
  return { kind, manifests };
}

export function inputWithManifest(input: unknown, manifest: DiffManifest): Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    throw new Error("Scheduled review input must contain a Diff Manifest");
  }
  return { ...input, manifest };
}

export function resolveProvider(config: PiprConfig, providerId: string): ProviderConfig {
  const provider = config.providers.find((item) => item.id === providerId);
  if (!provider) {
    throw new Error(`Provider '${providerId}' does not match any provider id`);
  }
  return provider;
}

function createAgentRunContext(runtime: RunReviewAgentOptions["runtime"]): AgentRunContext {
  const run = runtime.run;
  const repositorySlugParts = runtime.event.repository.slug.split("/");
  const repository = {
    root: runtime.workspace,
    owner: repositorySlugParts.length > 1 ? repositorySlugParts[0] : undefined,
    name: repositorySlugParts.at(-1) ?? "repo",
  };
  const change = {
    number: runtime.event.change.number,
    title: runtime.event.change.title,
    description: runtime.event.change.description,
    base: runtime.event.change.base,
    head: runtime.event.change.head,
  };
  const platform = { id: runtime.event.platform.id };
  return {
    prompt: { run, repository, change, platform },
    tools: { run, repository, change, platform },
  };
}

function retrySettings(agent: RuntimeAgent): RetrySettings {
  return retrySettingsSchema.parse({
    invalidOutput: agent.definition.retry?.invalidOutput ?? 1,
    transientFailure: agent.definition.retry?.transientFailure ?? 0,
  });
}

function resolveAgentTools(agent: RuntimeAgent, plan: RuntimePlan): AgentToolResolution {
  const customTools: RuntimeAgentTool[] = [];
  const unsupported: RuntimeAgentTool[] = [];
  const registeredTools = new Set(plan.tools);
  for (const tool of agent.definition.tools ?? []) {
    if (isBuiltinReadOnlyTool(tool)) {
      continue;
    }
    if (!isRunnableCustomTool(tool, registeredTools)) {
      unsupported.push(tool);
      continue;
    }
    customTools.push(tool);
  }
  if (unsupported.length > 0) {
    throw new Error(
      `Agent '${agent.name ?? "anonymous-agent"}' declares unregistered or invalid custom Pi tools: ${unsupported
        .map((tool) => tool.name)
        .join(", ")}`,
    );
  }
  return { customTools };
}

function isRunnableCustomTool(
  tool: RuntimeAgentTool,
  registeredTools: Set<RuntimeAgentTool>,
): boolean {
  return (
    registeredTools.has(tool) &&
    Boolean(tool.input) &&
    Boolean(tool.output) &&
    typeof tool.run === "function"
  );
}

function selectProviders(
  runtime: {
    providerOverride?: ProviderConfig;
    config: PiprConfig;
    provider: ProviderConfig;
  },
  agent: RuntimeAgent,
  runOptions: Parameters<TaskContext["pi"]["run"]>[2],
): ProviderConfig[] {
  if (runtime.providerOverride) {
    return [runtime.provider];
  }
  const primary = runOptions?.model ?? agent.definition.model;
  const fallbacks = runOptions?.fallbacks ?? agent.definition.fallbacks ?? [];
  const providers = [
    primary ? resolveProvider(runtime.config, primary.id) : runtime.provider,
    ...fallbacks.map((model) => resolveProvider(runtime.config, model.id)),
  ];
  return uniqBy(providers, (provider) => provider.id);
}
