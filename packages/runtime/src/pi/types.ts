import type { RunAgentEvent } from "../observability/types.js";
import type { ProviderConfig } from "../types.js";
import type { PiReadOnlyToolName } from "./contract.js";
import type { PiCustomToolRequest, PreparedPiCustomTools } from "./custom-tools.js";
import type { DiffContextCoverageObservation } from "./diff-context-coverage.js";
import type { PiRuntimeReadToolRequest, PreparedPiRuntimeReadTools } from "./runtime-tools.js";

export type PiRunOptions = {
  workspace: string;
  provider: ProviderConfig;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  piExecutable?: string;
  piAgentDir?: string;
  timeoutSeconds?: number;
  builtinTools?: readonly PiReadOnlyToolName[];
  runtimeTools?: PiRuntimeReadToolRequest;
  diffContext?: {
    manifest: PiRuntimeReadToolRequest["manifest"];
    mode: "full" | "condensed";
  };
  customTools?: PiCustomToolRequest;
  streamLimits?: PiStreamLimits;
  eventObserver?: (event: RunAgentEvent) => void;
};

export type PiRunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  models?: string[];
  usage?: PiRunUsage;
  stream?: PiRunStreamStats;
  diffContextCoverage?: DiffContextCoverageObservation;
};

export type PiRunStreamStats = {
  rawStdoutBytes: number;
  jsonEventCount: number;
  largestEventBytes: number;
  peakBufferedBytes: number;
};

export type PiStreamLimits = {
  maxJsonEventBytes: number;
  maxRawStdoutBytes: number;
  maxStderrBytes: number;
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

export type PiRunSandbox = {
  root: string;
  workspace: string;
  home: string;
  sessionDir: string;
  tmp: string;
};

export type PiProcessIdentity = {
  uid: number;
  gid: number;
};

export type PiWorkspaceScope = {
  sourceWorkspace: string;
  workspace: string;
  processIdentity?: PiProcessIdentity;
};

export type PiRunner = (options: PiRunOptions) => Promise<PiRunResult>;

export type PreparedPiTools = {
  extensionPath: string;
  runtimeRead?: PreparedPiRuntimeReadTools;
  custom?: PreparedPiCustomTools;
  toolNames: readonly string[];
};

export const defaultPiStreamLimits: PiStreamLimits = {
  maxJsonEventBytes: 16 * 1024 * 1024,
  maxRawStdoutBytes: 16 * 1024 * 1024,
  maxStderrBytes: 16 * 1024 * 1024,
};
