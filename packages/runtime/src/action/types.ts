import type { InitTypeSupportMode } from "../config/init.js";
import type { LoadedRuntimeProject } from "../config/project.js";
import type { GitHubCommandClient } from "../hosts/github/command.js";
import type { GitHubPublicationClient } from "../hosts/github/publication.js";
import type { CodeHostAdapter, CommandResponsePublicationResult } from "../hosts/types.js";
import type { PublicationResult } from "../review/publication-result.js";
import type { ReviewRuntimeResult } from "../review/task/task-runtime.js";
import type { ActionLogSink } from "../shared/logging.js";
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
  typeSupport?: InitTypeSupportMode;
};

export type DryRunCommandOptions = RuntimeCommandOptions & {
  eventPath: string;
};

export type ActionCommandOptions = RuntimeCommandOptions & {
  eventPath: string;
  dryRun: boolean;
  logSink?: ActionLogSink;
};

export type ActionCommandDependencyOptions = ActionCommandOptions & {
  piExecutable?: string;
  hostAdapter?: CodeHostAdapter;
  githubClient?: GitHubCommandClient;
  githubPublicationClient?: GitHubPublicationClient;
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
  logSink?: ActionLogSink;
  taskLog?: LocalReviewTaskLog;
};

export type DryRunCommandResult = {
  configSource: string;
  event: ChangeRequestEventContext;
};

export type InspectCommandResult = import("../config/project.js").InspectRuntimePlan;

export type LocalReviewCommandResult = ReviewRuntimeResult & {
  kind: "review" | "skipped";
  commandResponse?: never;
};

export type PublishedReviewRuntimeResult = Extract<ReviewRuntimeResult, { kind: "review" }>;

export type ActionCommandResult =
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
      response: {
        body: string;
      };
      publication: CommandResponsePublicationResult;
    }
  | {
      kind: "verifier";
      event: ChangeRequestEventContext;
      configSource: string;
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
      response: {
        commandName: string;
        body: string;
      };
    };

export type ValidateCommandResult = RuntimeSettings;
