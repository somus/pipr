import type { PiprRunSummary } from "@usepipr/sdk";
import type { InspectRuntimePlan, LoadedRuntimeProject } from "../config/project.js";
import type { CodeHostAdapter, CommandResponsePublicationResult } from "../hosts/types.js";
import type { PublicationResult } from "../review/publication-result.js";
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
};

export type DryRunCommandOptions = RuntimeCommandOptions & {
  host?: string;
  eventPath: string;
};

export type HostRunCommandOptions = RuntimeCommandOptions & {
  host?: string;
  eventPath?: string;
  dryRun: boolean;
  logSink?: RuntimeLogSink;
};

export type HostRunCommandDependencyOptions = HostRunCommandOptions & {
  piExecutable?: string;
  hostAdapter?: CodeHostAdapter;
  secretRedactor?: SecretRedactor;
};

export type LocalReviewTaskLog = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type LocalReviewCommandOptions = RuntimeCommandOptions & {
  baseSha: string;
  headSha?: string;
  piExecutable?: string;
  logSink?: RuntimeLogSink;
  taskLog?: LocalReviewTaskLog;
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
    }
  | {
      kind: "command-response";
      event: ChangeRequestEventContext;
      configSource: string;
      command: string;
      run: PiprRunSummary;
      response: {
        body: string;
      };
      publication: CommandResponsePublicationResult;
    }
  | {
      kind: "verifier";
      event: ChangeRequestEventContext;
      configSource: string;
      run: PiprRunSummary;
      errors: string[];
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
