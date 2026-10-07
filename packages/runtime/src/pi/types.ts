import type { AgentRunRequest, AgentWorkspaceToolName } from "../agent-worker/protocol.js";
import type { RunAgentEvent } from "../observability/types.js";
import type { ProviderConfig } from "../types.js";
import type { PiCustomToolRequest } from "./custom-tools.js";
import type { DiffContextCoverageObservation } from "./diff-context-coverage.js";
import type { PiRuntimeReadToolRequest } from "./runtime-tools.js";

export type PiConversation = AgentRunRequest["conversation"];

export type PiRunOptions = {
  workspace: string;
  provider: ProviderConfig;
  prompt: string;
  /** Stable identity of this model call; a repeated id resumes or returns the recorded answer. Defaults to a fresh id. */
  requestId?: string;
  conversation?: PiConversation;
  env?: NodeJS.ProcessEnv;
  providerModule?: PiProviderModule;
  /** Pi `auth.json` for models without an API key env var. */
  authFile?: string;
  timeoutSeconds?: number;
  builtinTools?: readonly AgentWorkspaceToolName[];
  runtimeTools?: PiRuntimeReadToolRequest;
  diffContext?: {
    manifest: PiRuntimeReadToolRequest["manifest"];
    mode: "full" | "condensed";
  };
  customTools?: PiCustomToolRequest;
  eventObserver?: (event: RunAgentEvent) => void;
};

/** Module whose default export receives `config` and returns replacement model providers, for scripted fixtures. */
export type PiProviderModule = { path: string; config?: string };

export type PiRunResult = {
  text: string;
  conversationId: number;
  durationMs: number;
  models: string[];
  usage: PiRunUsage;
  diffContextCoverage?: DiffContextCoverageObservation;
};

export type PiRunUsage = {
  status: "complete" | "partial";
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheUsageStatus?: "complete" | "partial" | "unavailable";
};

/** Runs one model call; failures throw `ProviderExecutionError`. */
export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;
