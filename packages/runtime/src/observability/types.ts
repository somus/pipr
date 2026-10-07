export type AgentAttemptType = "initial" | "retry" | "repair" | "fallback";

export const maximumRunBundleBytes = 64 * 1024 * 1024;

export type RunAgentAttemptResult = {
  output?: string;
  exitCode?: number;
  durationMs?: number;
  usage?: {
    status: "complete" | "partial";
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheUsageStatus?: "complete" | "partial" | "unavailable";
  };
  error?: string;
};

export type RunAgentAttemptObserver = {
  /** Whether the attempt's settled conversation should be read and handed to `event`. */
  capturesConversation?: boolean;
  event(event: RunAgentEvent): void;
  finish(result: RunAgentAttemptResult): Promise<void>;
};

/** Token and cost totals of one model turn or agent attempt. */
export type RunAgentUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
};

/** One committed harness entry; its content is diagnostic and stays in sensitive artifacts. */
export type RunConversationEntry = { id: number; kind: string } & Record<string, unknown>;

/** How an attempt's conversation began; content such as a fork's shared prompt is never included. */
export type RunAgentConversationStart =
  | { kind: "new" }
  | { kind: "continue"; conversationId: number }
  | { kind: "fork"; parentKey: string };

export type RunAgentEvent =
  | { kind: "first-response" }
  | { kind: "turn-start" }
  | {
      kind: "turn-end";
      model?: string;
      stopReason?: string;
      usage?: RunAgentUsage;
      entryKinds: string[];
    }
  /** The attempt's committed conversation, read from the harness store when the attempt settled. */
  | {
      kind: "conversation";
      conversationId: number;
      entries: RunConversationEntry[];
      truncated: boolean;
    }
  | {
      kind: "tool-start" | "tool-end";
      id: string;
      name: string;
      failed?: boolean;
      contentBytes?: number;
      contentHash?: string;
    }
  | { kind: "retry-start"; delayMs?: number }
  | { kind: "retry-end" | "compaction-start" | "compaction-end" };

export type RunTaskObserver = {
  finish(result: { status: "ok" | "error"; findings?: number; repairAttempted?: boolean }): void;
};

export type RunObserver = {
  registerSecret?(value: string): void;
  beginTask?(task: { name: string; order: number }): RunTaskObserver;
  recordArtifact?(artifact: {
    kind: RunBundleArtifact["kind"];
    name: string;
    mediaType: string;
    content: string;
    sensitive: boolean;
  }): Promise<void>;
  beginAgentAttempt(options: {
    attemptType: AgentAttemptType;
    attemptNumber: number;
    agent: string;
    task?: string;
    provider: string;
    model: string;
    authMode?: "api-key" | "subscription";
    shardIndex?: number;
    shardCount?: number;
    conversation?: RunAgentConversationStart;
    prompt: string;
  }): Promise<RunAgentAttemptObserver>;
};

import type { RunBundleArtifact } from "@usepipr/sdk";
