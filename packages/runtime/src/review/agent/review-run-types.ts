import type { PiprRunContext, TaskContext } from "@usepipr/sdk";
import type { RuntimeAgent, RuntimePlan } from "@usepipr/sdk/internal";
import type { DiffStructuralAnalysisLoader } from "../../diff/structural-analysis.js";
import type { RunObserver } from "../../observability/types.js";
import type { DiffContextCoverageObservation } from "../../pi/diff-context-coverage.js";
import type { ProviderFailureRemediation } from "../../pi/provider-failure.js";
import type { PiRunner, PiRunUsage } from "../../pi/types.js";
import type { PriorReviewState } from "../../publication/types.js";
import type { RuntimeLog } from "../../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig, ProviderConfig } from "../../types.js";
import type { ReviewWorkEvent } from "../progress.js";
import type { AgentRunBudget } from "./agent-run-budget.js";

export type PiRunStats = {
  models: string[];
  usage?: PiRunUsage;
  diffContextCoverage?: DiffContextCoverageObservation;
};

export type RunReviewAgentOptions = {
  agent: RuntimeAgent;
  input: unknown;
  runOptions: Parameters<TaskContext["pi"]["run"]>[2];
  toolMode?: "read-only" | "none";
  allowOversizedCondensedManifest?: boolean;
  shard?: { index: number; count: number };
  runtime: {
    workspace: string;
    config: PiprConfig;
    event: ChangeRequestEventContext;
    provider: ProviderConfig;
    providerOverride?: ProviderConfig;
    plan: RuntimePlan;
    env?: NodeJS.ProcessEnv;
    piExecutable?: string;
    piAgentDir?: string;
    piRunner?: PiRunner;
    taskContext?: TaskContext;
    taskName?: string;
    priorReviewState?: PriorReviewState;
    run: PiprRunContext;
    log?: RuntimeLog;
    piRunSink?: (run: PiRunStats) => void;
    runObserver?: RunObserver;
    reviewWork?: {
      taskId: string;
      reviewerId: string;
      reviewerName: string;
      reviewerOrder: number;
      emit(event: ReviewWorkEvent): void;
    };
    agentRunBudget?: AgentRunBudget;
    structuralAnalysis?: DiffStructuralAnalysisLoader;
    structuralToolsEnabled?: boolean;
  };
};

export type RunReviewAgentResult = {
  value: unknown;
  repairAttempted: boolean;
  providerModels: string[];
};

export type ParseAgentResult =
  | { ok: true; value: unknown; repairAttempted: boolean }
  | { ok: false; error: string };

export type RetrySettings = {
  invalidOutput: number;
  transientFailure: number;
};

export type AgentAttemptResult =
  | { ok: true; value: unknown; repairAttempted: boolean }
  | {
      ok: false;
      error: string;
      repairAttempted: boolean;
      remediation?: ProviderFailureRemediation;
    };
