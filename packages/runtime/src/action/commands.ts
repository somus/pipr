import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import { createRuntimeActionLog } from "../shared/logging.js";
import { parseChangeRequestEventContext } from "../types.js";
import { createActionHostAdapter } from "./action-host.js";
import { logEventContext, logPhase } from "./action-logging.js";
import { runIssueCommentActionCommand } from "./command-entry.js";
import { selectLocalReviewTasks } from "./entry-dispatch.js";
import { runPullRequestActionCommand } from "./pull-request-entry.js";
import type {
  ActionCommandDependencyOptions,
  ActionCommandOptions,
  ActionCommandResult,
  DryRunCommandOptions,
  DryRunCommandResult,
  InitCommandOptions,
  InspectCommandResult,
  LocalReviewCommandOptions,
  LocalReviewCommandResult,
  RuntimeCommandOptions,
  ValidateCommandResult,
} from "./types.js";
import { runReviewCommentReplyActionCommand } from "./verifier-entry.js";

export type { ActionLogRecord, ActionLogSink } from "../shared/logging.js";
export type {
  ActionCommandOptions,
  ActionCommandResult,
  DryRunCommandOptions,
  DryRunCommandResult,
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
    typeSupport: options.typeSupport,
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
  return inspectRuntimePlan(runtime.plan, runtime.settings.source);
}

/** Loads the runtime config and pull request event without running review publication. */
export async function runDryRunCommand(
  options: DryRunCommandOptions,
): Promise<DryRunCommandResult> {
  const runtime = await loadRuntimeProject({ ...options, requireProviderEnv: false });
  const adapter = createActionHostAdapter(options);
  const event = await adapter.events.parseEvent({
    eventPath: options.eventPath,
    env: {
      ...options.env,
      GITHUB_WORKSPACE: options.rootDir,
      GITHUB_EVENT_NAME: "pull_request",
    },
    workspace: options.rootDir,
  });
  return {
    configSource: runtime.settings.source,
    event,
  };
}

/** Runs configured change-request tasks against local Git base and head revisions. */
export async function runLocalReviewCommand(
  options: LocalReviewCommandOptions,
): Promise<LocalReviewCommandResult> {
  const log = options.logSink
    ? createRuntimeActionLog({ logSink: options.logSink, env: options.env })
    : undefined;
  log?.notice("local review start", {
    root: options.rootDir,
    configDir: options.configDir,
    base: options.baseSha.slice(0, 12),
    head: options.headSha?.slice(0, 12),
  });
  const runtime = await loadRuntimeProject({
    ...options,
    requireProviderEnv: true,
  });
  log?.notice("local config loaded", {
    source: runtime.settings.source,
    providers: runtime.settings.config.providers
      .map((provider) => `${provider.id}:${provider.model}`)
      .join(","),
    tasks: runtime.plan.tasks.length,
    commands: runtime.plan.commands.length,
  });
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
    selectedTasks,
    emptyTasksReason: "No change-request tasks are configured for local review",
    piExecutable: options.piExecutable,
    diffManifestBuilder: includeWorkingTree
      ? (diffOptions) => buildDiffManifest({ ...diffOptions, includeWorkingTree: true })
      : undefined,
    log,
    taskLog: options.taskLog,
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

/** Runs the GitHub Action workflow for pull request and issue-comment events. */
export async function runActionCommand(
  options: ActionCommandOptions,
): Promise<ActionCommandResult> {
  return await runActionCommandWithDependencies(options);
}

export async function runActionCommandWithDependencies(
  options: ActionCommandDependencyOptions,
): Promise<ActionCommandResult> {
  const log = createRuntimeActionLog({ logSink: options.logSink, env: options.env });
  return await log.group("pipr action", async () => {
    const eventName = (options.env ?? process.env).GITHUB_EVENT_NAME ?? "pull_request";
    log.notice("action start", {
      eventName,
      dryRun: options.dryRun,
      root: options.rootDir,
      configDir: options.configDir,
    });
    const adapter = createActionHostAdapter(options);
    await logPhase(log, "workspace", async () => {
      adapter.workspace.ensureWorkspaceSafeDirectory?.({
        rootDir: options.rootDir,
        env: options.env,
      });
    });
    if (eventName === "issue_comment") {
      return await runIssueCommentActionCommand(options, adapter, log);
    }
    if (eventName === "pull_request_review_comment") {
      return await runReviewCommentReplyActionCommand(options, adapter, log);
    }
    return await runPullRequestActionCommand(options, adapter, log);
  });
}
