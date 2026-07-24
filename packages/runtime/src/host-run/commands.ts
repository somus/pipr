import os from "node:os";
import path from "node:path";
import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import { createRuntimeLog } from "../shared/logging.js";
import { createKnownSecretRedactor } from "../shared/secret-redactor.js";
import { parseChangeRequestEventContext } from "../types.js";
import { createHostRunAdapter } from "./adapter.js";
import { runChangeRequestHostRunCommand } from "./change-request-entry.js";
import { runIssueCommentHostRunCommand } from "./command-entry.js";
import { selectLocalReviewTasks } from "./entry-dispatch.js";
import { logConfigWarnings, logEventContext, logPhase } from "./logging.js";
import type {
  DryRunCommandOptions,
  DryRunCommandResult,
  HostRunCommandDependencyOptions,
  HostRunCommandOptions,
  HostRunCommandResult,
  InitCommandOptions,
  InspectCommandResult,
  LocalReviewCommandOptions,
  LocalReviewCommandResult,
  RuntimeCommandOptions,
  ValidateCommandResult,
} from "./types.js";
import { runReviewCommentReplyHostRunCommand } from "./verifier-entry.js";

export type { RuntimeLogRecord, RuntimeLogSink } from "../shared/logging.js";
export type {
  DryRunCommandOptions,
  DryRunCommandResult,
  HostRunCommandOptions,
  HostRunCommandResult,
  InitCommandOptions,
  InspectCommandResult,
  LocalReviewCommandOptions,
  LocalReviewCommandResult,
  RuntimeCommandOptions,
} from "./types.js";

/** Initializes the official minimal `.pipr` project files. */
export async function runInitCommand(
  options: InitCommandOptions,
): Promise<InitOfficialMinimalProjectResult> {
  return await initOfficialMinimalProject({
    rootDir: options.rootDir,
    configDir: options.configDir,
    force: options.force,
    adapters: options.adapters,
    recipe: options.recipe,
    minimal: options.minimal,
  });
}

/** Loads and validates the runtime project configuration. */
export async function runValidateCommand(
  options: RuntimeCommandOptions,
): Promise<ValidateCommandResult> {
  return (
    await validateProject({
      ...options,
      requireProviderEnv: options.requireProviderEnv ?? false,
    })
  ).settings;
}

/** Returns an inspectable summary of the configured runtime plan. */
export async function runInspectCommand(
  options: RuntimeCommandOptions,
): Promise<InspectCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  return {
    ...inspectRuntimePlan(runtime.plan, runtime.settings.source),
    warnings: runtime.settings.warnings,
  };
}

/** Loads the runtime config and change request event without running review publication. */
export async function runDryRunCommand(
  options: DryRunCommandOptions,
): Promise<DryRunCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  const adapter = createHostRunAdapter(options);
  const hostEvent = await adapter.events.parseEvent({
    eventPath: options.eventPath,
    env: options.env ?? process.env,
    workspace: options.rootDir,
  });
  if (hostEvent.kind !== "change-request") {
    throw new Error(`dry-run requires a change-request event, received ${hostEvent.kind}`);
  }
  const event = hostEvent.change;
  return {
    configSource: runtime.settings.source,
    event,
    warnings: runtime.settings.warnings,
  };
}

/** Runs configured change-request tasks against local Git base and head revisions. */
export async function runLocalReviewCommand(
  options: LocalReviewCommandOptions,
): Promise<LocalReviewCommandResult> {
  const log = options.logSink
    ? createRuntimeLog({ logSink: options.logSink, env: options.env })
    : undefined;
  log?.notice("local review start", {
    root: options.rootDir,
    configDir: options.configDir,
    base: options.baseSha.slice(0, 12),
    head: options.headSha?.slice(0, 12),
  });
  const runtime = await loadRuntimeProject({
    ...options,
    requireProviderEnv: false,
  });
  log?.notice("local config loaded", {
    source: runtime.settings.source,
    providers: runtime.settings.config.providers
      .map((provider) => `${provider.id}:${provider.model}`)
      .join(","),
    tasks: runtime.plan.tasks.length,
    commands: runtime.plan.commands.length,
  });
  if (log) {
    logConfigWarnings(log, runtime.settings.warnings);
  }
  const selectedTasks = selectLocalReviewTasks(runtime.plan);
  const includeWorkingTree = options.headSha === undefined;
  const headSha = options.headSha ?? runGitCommand(["rev-parse", "HEAD"], options.rootDir).trim();
  const event = parseChangeRequestEventContext({
    ...createLocalChangeRequestEvent({
      rootDir: options.rootDir,
      baseSha: options.baseSha,
      headSha,
    }),
  });
  if (log) {
    logEventContext(log, event);
    log.notice("local dispatch", {
      selectedTasks: selectedTasks.map((task) => task.name),
      skippedLocalTasks: runtime.plan.tasks
        .filter((task) => task.local === false)
        .map((task) => task.name),
      diffTarget: includeWorkingTree ? "working-tree" : "head-ref",
    });
  }
  const result = await runTaskRuntime({
    workspace: options.rootDir,
    config: runtime.settings.config,
    event,
    env: options.env,
    plan: runtime.plan,
    versionCompatibility: runtime.versionCompatibility,
    selectedTasks,
    emptyTasksReason: "No change-request tasks are configured for local review",
    piExecutable: options.piExecutable,
    piAgentDir: resolveLocalPiAgentDir(options),
    structuralHeadRef: includeWorkingTree ? undefined : headSha,
    diffManifestBuilder: includeWorkingTree
      ? (diffOptions) => buildDiffManifest({ ...diffOptions, includeWorkingTree: true })
      : undefined,
    log,
    taskLog: options.taskLog,
    runTrigger: "local",
  });
  if (result.kind === "command-response") {
    throw new Error("command response result is only supported for issue_comment commands");
  }
  log?.notice("local review complete", {
    kind: result.kind,
    taskChecks: result.taskChecks.length,
    validFindings: result.kind === "review" ? result.validated.validFindings.length : undefined,
    droppedFindings: result.kind === "review" ? result.validated.droppedFindings.length : undefined,
    inlineDrafts: result.kind === "review" ? result.inlineCommentDrafts.length : undefined,
  });
  return result as LocalReviewCommandResult;
}

function resolveLocalPiAgentDir(options: LocalReviewCommandOptions): string {
  const env = options.env ?? process.env;
  const configured = options.piAgentDir ?? env.PI_CODING_AGENT_DIR;
  return configured
    ? path.resolve(options.rootDir, configured)
    : path.join(env.HOME ?? os.homedir(), ".pi", "agent");
}

/** Runs a normalized code host event through the selected adapter. */
export async function runHostRunCommand(
  options: HostRunCommandOptions,
): Promise<HostRunCommandResult> {
  return await runHostRunCommandWithDependencies({
    ...options,
    secretRedactor: createKnownSecretRedactor({ env: options.env ?? process.env }),
  });
}

export async function runHostRunCommandWithDependencies(
  options: HostRunCommandDependencyOptions,
): Promise<HostRunCommandResult> {
  const log = createRuntimeLog({ logSink: options.logSink, env: options.env });
  return await log.group("pipr host run", async () => {
    log.notice("host run start", {
      dryRun: options.dryRun,
      root: options.rootDir,
      configDir: options.configDir,
    });
    const adapter = createHostRunAdapter(options);
    await logPhase(log, "workspace", async () => {
      adapter.workspace.ensureWorkspaceSafeDirectory?.({
        rootDir: options.rootDir,
        env: options.env,
      });
    });
    const event = await logPhase(log, "parse event", async () =>
      adapter.events.parseEvent({
        eventPath: options.eventPath,
        env: options.env ?? process.env,
        workspace: options.rootDir,
      }),
    );
    log.notice("event dispatch", { kind: event.kind });
    switch (event.kind) {
      case "ignored":
        return event;
      case "command-comment":
        return await runIssueCommentHostRunCommand(options, adapter, log, event.comment);
      case "review-comment-reply":
        return await runReviewCommentReplyHostRunCommand(options, adapter, log, event.reply);
      case "change-request":
        return await runChangeRequestHostRunCommand(options, adapter, log, event.change);
    }
  });
}
