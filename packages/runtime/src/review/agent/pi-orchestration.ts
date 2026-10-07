import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import type { DurationInput, TaskContext } from "@usepipr/sdk";
import type { RuntimeAgentTool } from "@usepipr/sdk/internal";
import { match } from "ts-pattern";
import {
  type AgentWorkspaceToolName,
  agentWorkspaceToolNames,
} from "../../agent-worker/protocol.js";
import type { AgentAttemptType, RunAgentAttemptObserver } from "../../observability/types.js";
import type { PiCustomToolDefinition } from "../../pi/custom-tools.js";
import { ProviderExecutionError } from "../../pi/provider-failure.js";
import type { PiConversation, PiRunOptions, PiRunResult } from "../../pi/types.js";
import { boundedLogSnippet, type RuntimeLog } from "../../shared/logging.js";
import type { ProviderConfig } from "../../types.js";
import type { PreparedAgentContext } from "./agent-prompt.js";
import { AgentRunBudgetExhaustedError, reserveAgentRun } from "./agent-run-budget.js";
import type { RunReviewAgentOptions } from "./review-run-types.js";

export type AgentAttempt = {
  prompt: string;
  attemptType: AgentAttemptType;
  conversation?: PiConversation;
};

type ReviewAttempt = {
  attemptType: AgentAttemptType;
  attemptNumber: number;
  attemptId: string;
};

type PiRunTools = Pick<PiRunOptions, "builtinTools" | "runtimeTools" | "customTools">;

export function rethrowAgentRunBudgetExhaustion(error: unknown): void {
  if (error instanceof AgentRunBudgetExhaustedError) {
    throw error;
  }
}

/** Runs one model call; transient provider failures retry inside the harness, so failures here are final. */
export async function runPiAttempt(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  call: AgentAttempt,
): Promise<PiRunResult> {
  reserveAgentRun(options.runtime.agentRunBudget);
  const requestId = agentRequestId(options, provider, call);
  const tools: PiRunTools = {
    builtinTools: builtinToolsForPrompt(options.toolMode ?? "read-only"),
    runtimeTools: options.diffManifest?.runtimeToolRequest,
    customTools: customToolsForRun(options),
  };
  const timeoutSeconds = promptTimeoutSeconds(options);
  const observedStarted = Date.now();
  const attempt: ReviewAttempt = {
    attemptType: call.attemptType,
    attemptNumber: 1,
    attemptId: randomUUID(),
  };
  const observedAttempt = await beginObservedAttempt(options, provider, call.prompt, attempt);
  logPiStart(options, provider, call.prompt, tools, attempt);
  let result: PiRunResult;
  try {
    result = await options.runtime.piRunner({
      workspace: options.runtime.workspace,
      provider,
      prompt: call.prompt,
      requestId,
      ...(call.conversation ? { conversation: call.conversation } : {}),
      env: options.runtime.env,
      ...(options.runtime.piProviderModule
        ? { providerModule: options.runtime.piProviderModule }
        : {}),
      ...(options.runtime.piAuthFile ? { authFile: options.runtime.piAuthFile } : {}),
      ...tools,
      ...(options.diffManifest
        ? {
            diffContext: {
              manifest: options.diffManifest.manifest,
              mode: options.diffManifest.mode,
            },
          }
        : {}),
      timeoutSeconds,
      eventObserver: observedAttempt ? (event) => observedAttempt.event(event) : undefined,
    });
  } catch (error) {
    options.runtime.piRunSink?.({ models: [provider.model] });
    await finishObservedAttempt(options, observedAttempt, {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - observedStarted,
    });
    logPiRun(options, provider, attempt, {
      exitCode: -1,
      durationMs: Date.now() - observedStarted,
    });
    throw publicPiFailure(error, options.runtime.log);
  }
  const reportedModels = result.models.map((model) => model.trim()).filter(Boolean);
  options.runtime.piRunSink?.({
    models: reportedModels.length ? reportedModels : [provider.model],
    usage: result.usage,
    ...(result.diffContextCoverage ? { diffContextCoverage: result.diffContextCoverage } : {}),
  });
  logPiRun(options, provider, attempt, {
    exitCode: 0,
    durationMs: result.durationMs,
    outputBytes: Buffer.byteLength(result.text, "utf8"),
    timeoutSeconds,
    usageStatus: result.usage.status,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.usage.costUsd,
    cacheReadTokens: result.usage.cacheReadTokens,
    cacheWriteTokens: result.usage.cacheWriteTokens,
    cacheUsageStatus: result.usage.cacheUsageStatus,
  });
  await finishObservedAttempt(options, observedAttempt, {
    output: result.text,
    exitCode: 0,
    durationMs: result.durationMs,
    usage: result.usage,
  });
  return result;
}

/** When logs go to a sink, provider detail stays in the log; otherwise the error carries a redacted, bounded snippet. */
function publicPiFailure(error: unknown, log: RuntimeLog | undefined): unknown {
  if (!(error instanceof ProviderExecutionError) || error.detail === undefined) {
    return error;
  }
  log?.textSnippet("error", "pi failure", error.detail);
  if (log?.writesToSink) {
    return new ProviderExecutionError(error.message, error.remediation);
  }
  const snippet = log ? log.formatTextSnippet(error.detail) : boundedLogSnippet(error.detail);
  return new ProviderExecutionError(`${error.message}:\n${snippet}`, error.remediation);
}

/**
 * Identifies one model call within a run. The run id is stable for an event, so a redelivered webhook or rerun job
 * asks the same questions and resumes recorded conversations instead of calling the model again. Repeated identical
 * calls in one run, such as sampling one agent several times, are numbered so each gets its own answer.
 */
function agentRequestId(
  options: RunReviewAgentOptions,
  provider: ProviderConfig,
  call: AgentAttempt,
): string {
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        options.runtime.run.id,
        options.runtime.taskName ?? null,
        options.agent.name ?? null,
        options.shard ? [options.shard.index, options.shard.count] : null,
        provider.id,
        call.attemptType,
        call.conversation ?? null,
        call.prompt,
      ]),
    )
    .digest("hex");
  const ordinals = options.runtime.agentRunBudget?.requestOrdinals;
  const ordinal = ordinals?.get(identity) ?? 0;
  ordinals?.set(identity, ordinal + 1);
  return ordinal === 0 ? identity : `${identity}:${ordinal}`;
}

function customToolsForRun(
  options: RunReviewAgentOptions & PreparedAgentContext,
): PiRunOptions["customTools"] {
  if (options.toolMode === "none" || options.agentTools.customTools.length === 0) {
    return undefined;
  }
  const context = options.runtime.taskContext;
  if (!context) {
    throw new Error("Custom Pi tools require a task context");
  }
  return {
    context,
    tools: options.agentTools.customTools.map(customToolDefinition),
  };
}

function customToolDefinition(tool: RuntimeAgentTool): PiCustomToolDefinition {
  const { input, output, run } = tool;
  if (!input || !output || !run) {
    throw new Error(`Custom Pi tool '${tool.name}' is missing input, output, or run`);
  }
  return {
    name: tool.name,
    description: tool.description,
    input,
    output,
    async execute(context, input) {
      return await run({ input, ctx: context as TaskContext });
    },
  };
}

function promptTimeoutSeconds(
  options: RunReviewAgentOptions & PreparedAgentContext,
): number | undefined {
  return effectiveTimeoutSeconds(
    options.runOptions?.timeout ?? options.agent.definition.timeout,
    options.runtime.config.limits?.timeoutSeconds,
  );
}

function logPiStart(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
  tools: PiRunTools,
  attempt: ReviewAttempt,
): void {
  options.runtime.log?.info("pi start", {
    agent: options.agent.name ?? "anonymous-agent",
    provider: provider.id,
    model: provider.model,
    ...attempt,
    ...attemptContextFields(options, provider),
    promptBytes: Buffer.byteLength(prompt, "utf8"),
    tools: [
      ...(tools.builtinTools ?? []),
      ...(tools.runtimeTools ? ["pipr-runtime-tools"] : []),
      ...(tools.customTools?.tools.map((tool) => tool.name) ?? []),
    ],
  });
}

function logPiRun(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  attempt: ReviewAttempt,
  fields: Record<string, string | number | undefined>,
): void {
  options.runtime.log?.info("pi run", {
    agent: options.agent.name ?? "anonymous-agent",
    provider: provider.id,
    model: provider.model,
    ...attempt,
    ...attemptContextFields(options, provider),
    ...fields,
  });
}

async function beginObservedAttempt(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
  attempt: Pick<ReviewAttempt, "attemptType" | "attemptNumber">,
): Promise<RunAgentAttemptObserver | undefined> {
  try {
    return await options.runtime.runObserver?.beginAgentAttempt({
      attemptType: attempt.attemptType,
      attemptNumber: attempt.attemptNumber,
      agent: options.agent.name ?? "anonymous-agent",
      task: options.runtime.taskName,
      provider: provider.id,
      model: provider.model,
      authMode: provider.apiKeyEnv ? "api-key" : "subscription",
      ...(options.shard
        ? { shardIndex: options.shard.index, shardCount: options.shard.count }
        : {}),
      prompt,
    });
  } catch {
    options.runtime.log?.warning("run capture attempt start failed", {
      agent: options.agent.name ?? "anonymous-agent",
      provider: provider.id,
      model: provider.model,
    });
    return undefined;
  }
}

function attemptContextFields(
  options: RunReviewAgentOptions,
  provider: ProviderConfig,
): Record<string, string | number | undefined> {
  return {
    task: options.runtime.taskName,
    authMode: provider.apiKeyEnv ? "api-key" : "subscription",
    ...(options.shard ? { shardIndex: options.shard.index, shardCount: options.shard.count } : {}),
  };
}

async function finishObservedAttempt(
  options: RunReviewAgentOptions & PreparedAgentContext,
  observer: RunAgentAttemptObserver | undefined,
  result: Parameters<RunAgentAttemptObserver["finish"]>[0],
): Promise<void> {
  if (!observer) return;
  try {
    await observer.finish(result);
  } catch {
    options.runtime.log?.warning("run capture attempt finish failed", {
      agent: options.agent.name ?? "anonymous-agent",
    });
  }
}

function builtinToolsForPrompt(toolMode: "read-only" | "none"): readonly AgentWorkspaceToolName[] {
  return toolMode === "none" ? [] : agentWorkspaceToolNames;
}

function effectiveTimeoutSeconds(
  timeout: DurationInput | undefined,
  fallback: number | undefined,
): number | undefined {
  if (timeout === undefined) return fallback;
  const seconds = parseDurationSeconds(timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Agent timeout '${timeout}' must be greater than zero`);
  }
  return seconds;
}

function parseDurationSeconds(value: DurationInput): number {
  if (typeof value === "number") {
    return value;
  }
  const durationMatch = /^(?<amount>\d+)(?<unit>[smh])$/.exec(value);
  if (!durationMatch?.groups) {
    throw new Error(`Invalid duration '${value}'`);
  }
  const amount = Number(durationMatch.groups.amount);
  const unit = durationMatch.groups.unit;
  return match(unit)
    .with("h", () => amount * 60 * 60)
    .with("m", () => amount * 60)
    .with("s", () => amount)
    .otherwise(() => {
      throw new Error(`Invalid duration '${value}'`);
    });
}
