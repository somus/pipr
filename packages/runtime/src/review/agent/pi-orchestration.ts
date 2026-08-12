import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { DurationInput, TaskContext } from "@usepipr/sdk";
import type { RuntimeAgentTool } from "@usepipr/sdk/internal";
import { match } from "ts-pattern";
import type { AgentAttemptType, RunAgentAttemptObserver } from "../../observability/types.js";
import { type PiReadOnlyToolName, piReadOnlyToolNames } from "../../pi/contract.js";
import type { PiCustomToolDefinition } from "../../pi/custom-tools.js";
import { classifyProviderFailure, ProviderExecutionError } from "../../pi/provider-failure.js";
import { runPi } from "../../pi/runner.js";
import type { PiRunResult } from "../../pi/types.js";
import { boundedLogSnippet, type RuntimeLog } from "../../shared/logging.js";
import type { ProviderConfig } from "../../types.js";
import type { PreparedAgentContext } from "./agent-prompt.js";
import { AgentRunBudgetExhaustedError, reserveAgentRun } from "./agent-run-budget.js";
import type { RetrySettings, RunReviewAgentOptions } from "./review-run-types.js";

type ReviewAttempt = {
  attemptType: AgentAttemptType;
  attemptNumber: number;
  attemptId: string;
};

type PiRunTools = {
  builtinTools: readonly PiReadOnlyToolName[];
  runtimeTools: Parameters<typeof runPi>[0]["runtimeTools"];
  customTools: Parameters<typeof runPi>[0]["customTools"];
};

export async function runPiWithTransientRetries(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
  retry: RetrySettings,
  attemptType: AgentAttemptType,
): Promise<PiRunResult> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retry.transientFailure; attempt += 1) {
    try {
      return await runPiForPrompt(
        options,
        provider,
        prompt,
        attempt === 0 ? attemptType : "retry",
        attempt + 1,
      );
    } catch (error) {
      rethrowAgentRunBudgetExhaustion(error);
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export function rethrowAgentRunBudgetExhaustion(error: unknown): void {
  if (error instanceof AgentRunBudgetExhaustedError) {
    throw error;
  }
}

async function runPiForPrompt(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
  attemptType: AgentAttemptType,
  attemptNumber: number,
): Promise<PiRunResult> {
  reserveAgentRun(options.runtime.agentRunBudget);
  const tools: PiRunTools = {
    builtinTools: builtinToolsForPrompt(options.toolMode ?? "read-only"),
    runtimeTools: runtimeToolsForRun(options),
    customTools: customToolsForRun(options),
  };
  const timeoutSeconds = promptTimeoutSeconds(options);
  const observedStarted = Date.now();
  const attempt: ReviewAttempt = {
    attemptType,
    attemptNumber,
    attemptId: randomUUID(),
  };
  const observedAttempt = await beginObservedAttempt(options, provider, prompt, attempt);
  logPiStart(options, provider, prompt, tools, attempt);
  let result: PiRunResult;
  try {
    result = await executeObservedPi(options, provider, prompt, timeoutSeconds, {
      ...tools,
      observedAttempt,
    });
  } catch (error) {
    await reportObservedPiFailure(
      options,
      provider,
      observedAttempt,
      observedStarted,
      attempt,
      error,
    );
    throw error;
  }
  await reportObservedPiResult(options, provider, observedAttempt, result, timeoutSeconds, attempt);
  assertSuccessfulPiResult(result, options.runtime.log, provider);
  return result;
}

type ObservedAttempt = Awaited<ReturnType<typeof beginObservedAttempt>>;

async function executeObservedPi(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  prompt: string,
  timeoutSeconds: number | undefined,
  tools: PiRunTools & {
    observedAttempt: ObservedAttempt;
  },
): Promise<PiRunResult> {
  return await (options.runtime.piRunner ?? runPi)({
    workspace: options.runtime.workspace,
    provider,
    prompt,
    env: options.runtime.env,
    piExecutable: options.runtime.piExecutable,
    piAgentDir: options.runtime.piAgentDir,
    builtinTools: tools.builtinTools,
    runtimeTools: tools.runtimeTools,
    ...(options.diffManifest
      ? {
          diffContext: {
            manifest: options.diffManifest.manifest,
            mode: options.diffManifest.mode,
          },
        }
      : {}),
    customTools: tools.customTools,
    timeoutSeconds,
    eventObserver: tools.observedAttempt
      ? (event) => tools.observedAttempt?.event(event)
      : undefined,
  });
}

async function reportObservedPiFailure(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  observedAttempt: ObservedAttempt,
  observedStarted: number,
  attempt: ReviewAttempt,
  error: unknown,
): Promise<void> {
  options.runtime.piRunSink?.({ models: [provider.model] });
  await finishObservedAttempt(options, observedAttempt, {
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - observedStarted,
  });
  logPiFailure(options, provider, attempt, Date.now() - observedStarted);
}

async function reportObservedPiResult(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  observedAttempt: ObservedAttempt,
  result: PiRunResult,
  timeoutSeconds: number | undefined,
  attempt: ReviewAttempt,
): Promise<void> {
  const reportedModels = result.models?.map((model) => model.trim()).filter(Boolean);
  options.runtime.piRunSink?.({
    models: reportedModels?.length ? reportedModels : [provider.model],
    ...(result.usage ? { usage: result.usage } : {}),
    ...(result.diffContextCoverage ? { diffContextCoverage: result.diffContextCoverage } : {}),
  });
  logPiResult(options, provider, result, timeoutSeconds, attempt);
  await finishObservedAttempt(options, observedAttempt, {
    output: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    usage: result.usage,
  });
}

function runtimeToolsForRun(
  options: RunReviewAgentOptions & PreparedAgentContext,
): Parameters<typeof runPi>[0]["runtimeTools"] {
  return options.diffManifest?.runtimeToolRequest;
}

function customToolsForRun(
  options: RunReviewAgentOptions & PreparedAgentContext,
): Parameters<typeof runPi>[0]["customTools"] {
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
      ...tools.builtinTools,
      ...(tools.runtimeTools ? ["pipr-runtime-tools"] : []),
      ...(tools.customTools?.tools.map((tool) => tool.name) ?? []),
    ],
  });
}

function logPiResult(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  result: PiRunResult,
  timeoutSeconds: number | undefined,
  attempt: ReviewAttempt,
): void {
  options.runtime.log?.info("pi run", {
    agent: options.agent.name ?? "anonymous-agent",
    provider: provider.id,
    model: provider.model,
    ...attempt,
    ...attemptContextFields(options, provider),
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    stdoutBytes: result.stdout.length,
    stderrBytes: result.stderr.length,
    timeoutSeconds,
    ...(result.stream ?? {}),
    ...(result.usage
      ? {
          usageStatus: result.usage.status,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          costUsd: result.usage.costUsd,
          cacheReadTokens: result.usage.cacheReadTokens,
          cacheWriteTokens: result.usage.cacheWriteTokens,
          cacheUsageStatus: result.usage.cacheUsageStatus,
        }
      : {}),
  });
}

function logPiFailure(
  options: RunReviewAgentOptions & PreparedAgentContext,
  provider: ProviderConfig,
  attempt: ReviewAttempt,
  durationMs: number,
): void {
  options.runtime.log?.info("pi run", {
    agent: options.agent.name ?? "anonymous-agent",
    provider: provider.id,
    model: provider.model,
    ...attempt,
    ...attemptContextFields(options, provider),
    exitCode: -1,
    durationMs,
    stdoutBytes: 0,
    stderrBytes: 0,
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

function builtinToolsForPrompt(toolMode: "read-only" | "none"): readonly PiReadOnlyToolName[] {
  return toolMode === "none" ? [] : piReadOnlyToolNames;
}

function effectiveTimeoutSeconds(
  timeout: DurationInput | undefined,
  fallback: number | undefined,
): number | undefined {
  return timeout === undefined ? fallback : parseDurationSeconds(timeout);
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

function assertSuccessfulPiResult(
  result: PiRunResult,
  log: RuntimeLog | undefined,
  provider: ProviderConfig,
): void {
  if (result.exitCode === 0) {
    return;
  }
  if (result.stderr.trim()) {
    log?.textSnippet("error", "pi stderr", result.stderr);
  }
  if (result.stdout.trim()) {
    log?.textSnippet("error", "pi stdout", result.stdout);
  }
  const remediation = classifyProviderFailure({
    provider,
    output: boundedProviderFailureEvidence(result.stderr),
  });
  if (!log?.writesToSink) {
    const output = result.stderr.trim() || result.stdout.trim() || "no output";
    const detail = log ? log.formatTextSnippet(output) : boundedLogSnippet(output);
    throw new ProviderExecutionError(
      `Pi agent failed with exit ${result.exitCode}:\n${detail}`,
      remediation,
    );
  }
  throw new ProviderExecutionError(`Pi agent failed with exit ${result.exitCode}`, remediation);
}

function boundedProviderFailureEvidence(stderr: string): string {
  const maximumBytes = 64 * 1024;
  if (Buffer.byteLength(stderr, "utf8") <= maximumBytes) {
    return stderr;
  }
  const bytes = Buffer.from(stderr, "utf8");
  const half = maximumBytes / 2;
  return `${bytes.subarray(0, half).toString("utf8")}\n${bytes
    .subarray(bytes.byteLength - half)
    .toString("utf8")}`;
}
