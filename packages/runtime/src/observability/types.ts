export type AgentAttemptType = "initial" | "retry" | "repair" | "fallback";

export const maximumRunBundleBytes = 64 * 1024 * 1024;

export type RunAgentAttemptResult = {
  output?: string;
  stderr?: string;
  exitCode?: number;
  durationMs?: number;
  usage?: {
    status: "complete" | "partial";
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
  error?: string;
};

export type RunAgentAttemptObserver = {
  event(event: RunAgentEvent): void;
  finish(result: RunAgentAttemptResult): Promise<void>;
};

export type RunAgentEvent =
  | { kind: "first-response" }
  | {
      kind: "tool-start" | "tool-end";
      id: string;
      name: string;
      failed?: boolean;
      contentBytes?: number;
      contentHash?: string;
    }
  | { kind: "retry-start" | "retry-end" | "compaction-start" | "compaction-end" };

export type RunObserver = {
  registerSecret?(value: string): void;
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
    provider: string;
    model: string;
    prompt: string;
  }): Promise<RunAgentAttemptObserver>;
};

import type { RunBundleArtifact } from "@usepipr/sdk";
