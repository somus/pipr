import type { PiprRunContext, TaskContext } from "@usepipr/sdk";
import type { RuntimePlan, RuntimeTask } from "@usepipr/sdk/internal";
import type { ConfigVersionCompatibility } from "../../config/version-compat.js";
import type { BuildDiffManifestOptions } from "../../diff/diff.js";
import type { RunObserver } from "../../observability/types.js";
import type { PiRunner } from "../../pi/types.js";
import type {
  InlineThreadContext,
  PriorReviewState,
  ReviewStats,
} from "../../publication/types.js";
import type { RuntimeLog } from "../../shared/logging.js";
import type { SecretRedactor } from "../../shared/secret-redaction.js";
import type {
  ChangeRequestEventContext,
  DiffManifest,
  PiprConfig,
  ProviderConfig,
} from "../../types.js";
import type { ReviewProgressSink } from "../progress.js";
import type { RuntimeCommandInvocation } from "../run-identity.js";
import type { RuntimeCheckSink } from "./task-output.js";

export type DiffManifestBuilder = (options: BuildDiffManifestOptions) => DiffManifest;

/** Injectable ports for task runtime (wired by host-run composition or tests). */
export type TaskRuntimePorts = {
  env?: NodeJS.ProcessEnv;
  providerOverride?: ProviderConfig;
  piExecutable?: string;
  piAgentDir?: string;
  piRunner?: PiRunner;
  structuralHeadRef?: string;
  diffManifestBuilder?: DiffManifestBuilder;
  priorReviewState?: PriorReviewState;
  priorMainComment?: string;
  loadPriorReviewState?: () => Promise<PriorReviewState | undefined>;
  loadPriorMainComment?: () => Promise<string | undefined>;
  loadInlineThreadContexts?: () => Promise<InlineThreadContext[]>;
  checkSink?: RuntimeCheckSink;
  log?: RuntimeLog;
  taskLog?: TaskContext["log"];
  secretRedactor?: SecretRedactor;
  runObserver?: RunObserver;
  progress?: ReviewProgressSink & {
    recordStats(stats: ReviewStats | undefined): void;
  };
};

/** Per-run request fields for task runtime. */
export type TaskRuntimeRequest = {
  workspace: string;
  config: PiprConfig;
  event: ChangeRequestEventContext;
  plan: RuntimePlan;
  versionCompatibility?: ConfigVersionCompatibility;
  taskName?: string;
  taskInput?: unknown;
  selectedTasks?: readonly RuntimeTask[];
  emptyTasksReason?: string;
  trustedConfigSha?: string;
  trustedConfigHash?: string;
  commandInvocation?: RuntimeCommandInvocation;
  runTrigger?: Exclude<PiprRunContext["trigger"], "verifier">;
  workflowUrl?: string;
};

/** Flat entry options: request fields plus injectable ports. */
export type RunTaskRuntimeOptions = TaskRuntimeRequest & TaskRuntimePorts;
