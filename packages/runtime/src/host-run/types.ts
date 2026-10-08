import type { FindingOutcomeEvent, FindingThreadResolution, PiprRunSummary } from "@usepipr/sdk";
import type { InspectRuntimePlan, LoadedRuntimeProject } from "../config/project.js";
import type { CodeHostAdapter, CommandResponsePublicationResult } from "../hosts/types.js";
import type { PublishedRunBundle } from "../observability/run-bundle-publication.js";
import type { RunObserver } from "../observability/types.js";
import type { PiProviderModule, PiRunner } from "../pi/types.js";
import type { PublicationResult } from "../publication/types.js";
import type { ReviewRuntimeResult } from "../review/task/task-runtime.js";
import type { RuntimeLogSink } from "../shared/logging.js";
import type { SecretRedactor } from "../shared/secret-redaction.js";
import type { ChangeRequestEventContext, RuntimeSettings } from "../types.js";

export type RuntimeCommandOptions = {
  rootDir: string;
  configDir: string;
  env?: NodeJS.ProcessEnv;
  requireProviderEnv?: boolean;
};

export type InitCommandOptions = RuntimeCommandOptions & {
  force: boolean;
  adapters?: readonly string[];
  recipe?: string;
  minimal?: boolean;
  runtimeImage?: string;
  checkoutAction?: string;
  githubRunner?: string;
  githubEnterpriseServer?: boolean;
};

export type DryRunCommandOptions = RuntimeCommandOptions & {
  host?: string;
  eventPath: string;
};

export type HostRunCommandOptions = Omit<RuntimeCommandOptions, "rootDir"> & {
  /** Workspace root; defaults to the CI checkout directory from env, then `cwd`. */
  rootDir?: string;
  /** Base for relative event paths and the workspace fallback; defaults to `process.cwd()`. */
  cwd?: string;
  host?: string;
  /** Native event payload; defaults to `PIPR_EVENT_PATH` or the CI event path from env. */
  eventPath?: string;
  dryRun: boolean;
  logSink?: RuntimeLogSink;
  /** Root for per-change-request agent stores so redelivered events resume prior conversations. */
  piStoreRoot?: string;
  onRunBundleFinalized?: (bundle: {
    executionId: string;
    directory: string;
    kind: "review" | "command" | "verifier" | "startup";
    outcome: "in-progress" | "succeeded" | "failed" | "partial";
    repository?: import("@usepipr/sdk").RunBundleManifest["repository"];
  }) => void | Promise<void>;
  /**
   * Opts into publishing native-CI captures: runtime packages the temporary capture into the
   * run store, removes the temporary directory, and reports the package for artifact upload.
   */
  onRunBundlePublished?: (bundle: PublishedRunBundle) => void | Promise<void>;
  /**
   * Receives the Finding Outcome events the run recorded once it ends, including when it fails
   * after recording some, such as a partial publication failure.
   */
  onFindingEvents?: (findings: HostRunFindingEvents) => void;
};

/** Content-free Finding Outcome events of one host run, with the code host context they need. */
export type HostRunFindingEvents = {
  repository: string;
  /** Whether the code host reports native thread resolution. */
  threadResolution: FindingThreadResolution;
  events: FindingOutcomeEvent[];
};

/** Injection bag accepted only at the host-run composition root. */
export type HostRunCommandDependencyOptions = HostRunCommandOptions & {
  piProviderModule?: PiProviderModule;
  piRunner?: PiRunner;
  hostAdapter?: CodeHostAdapter;
  secretRedactor?: SecretRedactor;
  runObserver?: RunObserver;
};

export type LocalReviewTaskLog = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type LocalReviewCommandOptions = RuntimeCommandOptions & {
  baseSha: string;
  headSha?: string;
  piProviderModule?: PiProviderModule;
  piAuthFile?: string;
  piRunner?: PiRunner;
  logSink?: RuntimeLogSink;
  taskLog?: LocalReviewTaskLog;
  traceDirectory?: string;
  runObserver?: RunObserver;
};

export type DryRunCommandResult = {
  configSource: string;
  event: ChangeRequestEventContext;
  warnings: string[];
};

export type InspectCommandResult = InspectRuntimePlan & {
  warnings: string[];
};

export type LocalReviewCommandResult = ReviewRuntimeResult & {
  kind: "review" | "skipped";
  commandResponse?: never;
};

export type PublishedReviewRuntimeResult = Extract<ReviewRuntimeResult, { kind: "review" }>;

export type HostRunCommandResult =
  | {
      kind: "ignored";
      reason: string;
    }
  | {
      kind: "dry-run";
      event: ChangeRequestEventContext;
      configSource: string;
    }
  | {
      kind: "command-help";
      event: ChangeRequestEventContext;
      configSource: string;
      body: string;
      reason: string;
    }
  | {
      kind: "review";
      event: ChangeRequestEventContext;
      configSource: string;
      command?: string;
      review: PublishedReviewRuntimeResult;
      publication: PublicationResult;
      /** Content-free Finding Outcome events this execution recorded. */
      findingEvents: FindingOutcomeEvent[];
    }
  | {
      kind: "command-response";
      run: PiprRunSummary;
      event: ChangeRequestEventContext;
      configSource: string;
      command: string;
      response: {
        body: string;
      };
      publication: CommandResponsePublicationResult;
    }
  | {
      kind: "verifier";
      run: PiprRunSummary;
      event: ChangeRequestEventContext;
      configSource: string;
      errors: string[];
      /** Content-free Finding Outcome events this execution recorded. */
      findingEvents: FindingOutcomeEvent[];
    };

export type TrustedRuntimeProject = LoadedRuntimeProject & {
  trustedConfigSha: string;
  trustedConfigHash: string;
};

export type TrustedReviewAndPublishResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "completed";
      review: PublishedReviewRuntimeResult;
      publication: PublicationResult;
    }
  | {
      kind: "command-response";
      run: PiprRunSummary;
      response: {
        commandName: string;
        body: string;
      };
    };

export type ValidateCommandResult = RuntimeSettings;
