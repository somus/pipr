import os from "node:os";
import path from "node:path";
import { loadRuntimeProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import { startFileRunRecorder } from "../observability/file-run-recorder.js";
import type { RunFailureCategory, RunRecorder } from "../observability/recorder-types.js";
import { combineRuntimeLogSinks } from "../observability/runtime-log-sinks.js";
import { selectLocalReviewTasks } from "../review/task/select-runtime-tasks.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import { createRuntimeLog } from "../shared/logging.js";
import { parseChangeRequestEventContext } from "../types.js";
import { classifyRunFailure, finishRecorderSafely } from "./commands-shared.js";
import { logConfigWarnings, logEventContext } from "./logging.js";
import type { LocalReviewCommandOptions, LocalReviewCommandResult } from "./types.js";

/** Runs configured change-request tasks against local Git base and head revisions. */
export async function runLocalReviewCommand(
  options: LocalReviewCommandOptions,
): Promise<LocalReviewCommandResult> {
  const recorder = await startLocalRecorder(options);
  const runOptions = recorder ? { ...options, runObserver: recorder.observer } : options;
  const logSink = combineRuntimeLogSinks(options.logSink, recorder?.logSink);
  const log = logSink
    ? createRuntimeLog({
        logSink,
        env: options.env,
        writesToSink: options.logSink !== undefined,
      })
    : undefined;
  let failureCategory: RunFailureCategory = "trusted-config";
  let reviewStarted = false;
  let localRepository: import("@usepipr/sdk").RunBundleManifest["repository"] | undefined;
  try {
    log?.notice("local review start", {
      root: options.rootDir,
      configDir: options.configDir,
      base: options.baseSha.slice(0, 12),
      head: options.headSha?.slice(0, 12),
    });
    const runtime = await loadRuntimeProject({
      ...runOptions,
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
    logLocalConfigWarnings(log, runtime.settings.warnings);
    failureCategory = "dispatch";
    reviewStarted = true;
    const selectedTasks = selectLocalReviewTasks(runtime.plan);
    const includeWorkingTree = options.headSha === undefined;
    const headSha = options.headSha ?? runGitCommand(["rev-parse", "HEAD"], options.rootDir).trim();
    localRepository = {
      host: "local",
      repository: path.basename(options.rootDir),
      baseSha: options.baseSha,
      headSha,
    };
    const event = parseChangeRequestEventContext({
      ...createLocalChangeRequestEvent({
        rootDir: options.rootDir,
        baseSha: options.baseSha,
        headSha,
      }),
    });
    logLocalDispatch(log, event, {
      selectedTasks: selectedTasks.map((task) => task.name),
      skippedLocalTasks: runtime.plan.tasks
        .filter((task) => task.local === false)
        .map((task) => task.name),
      diffTarget: includeWorkingTree ? "working-tree" : "head-ref",
    });
    const result = await runTaskRuntime({
      workspace: options.rootDir,
      config: runtime.settings.config,
      event,
      env: runOptions.env,
      plan: runtime.plan,
      versionCompatibility: runtime.versionCompatibility,
      selectedTasks,
      emptyTasksReason: "No change-request tasks are configured for local review",
      piExecutable: runOptions.piExecutable,
      piAgentDir: resolveLocalPiAgentDir(runOptions),
      piRunner: runOptions.piRunner,
      structuralHeadRef: includeWorkingTree ? undefined : headSha,
      diffManifestBuilder: includeWorkingTree
        ? (diffOptions) => buildDiffManifest({ ...diffOptions, includeWorkingTree: true })
        : undefined,
      log,
      taskLog: options.taskLog,
      runTrigger: "local",
      runObserver: runOptions.runObserver,
    });
    if (result.kind === "command-response") {
      throw new Error("command response result is only supported for issue_comment commands");
    }
    log?.notice("local review complete", {
      kind: result.kind,
      taskChecks: result.taskChecks.length,
      validFindings: result.kind === "review" ? result.validated.validFindings.length : undefined,
      droppedFindings:
        result.kind === "review" ? result.validated.droppedFindings.length : undefined,
      inlineDrafts: result.kind === "review" ? result.inlineCommentDrafts.length : undefined,
    });
    await finishRecorderSafely(recorder, log, successfulLocalReviewRun(result, localRepository));
    return result as LocalReviewCommandResult;
  } catch (error) {
    await finishRecorderSafely(recorder, log, {
      kind: reviewStarted ? "review" : "startup",
      outcome: "failed",
      failureCategory: classifyRunFailure(error, failureCategory),
      ...(localRepository ? { repository: localRepository } : {}),
    });
    throw error;
  }
}

function logLocalConfigWarnings(
  log: ReturnType<typeof createRuntimeLog> | undefined,
  warnings: string[],
): void {
  if (log) logConfigWarnings(log, warnings);
}

function logLocalDispatch(
  log: ReturnType<typeof createRuntimeLog> | undefined,
  event: Parameters<typeof logEventContext>[1],
  fields: {
    selectedTasks: string[];
    skippedLocalTasks: string[];
    diffTarget: "working-tree" | "head-ref";
  },
): void {
  if (!log) return;
  logEventContext(log, event);
  log.notice("local dispatch", fields);
}

function successfulLocalReviewRun(
  result: LocalReviewCommandResult,
  repository: import("@usepipr/sdk").RunBundleManifest["repository"],
): Parameters<RunRecorder["finish"]>[0] {
  if (result.kind !== "review") {
    return { kind: "review", outcome: "succeeded", repository };
  }
  return {
    kind: "review",
    outcome: "succeeded",
    workId: result.run.id,
    configVersion: result.publicationPlan.metadata.configVersion,
    configHash: result.publicationPlan.metadata.trustedConfigHash,
    repository,
  };
}

async function startLocalRecorder(
  options: LocalReviewCommandOptions,
): Promise<RunRecorder | undefined> {
  if (!options.traceDirectory) return undefined;
  try {
    const env = options.env ?? process.env;
    const mode = requestedCaptureMode(env);
    if (!mode) return undefined;
    return await startFileRunRecorder({
      rootDirectory: options.traceDirectory,
      env,
      mode,
    });
  } catch (error) {
    options.logSink?.log({
      level: "warning",
      event: "run capture unavailable",
      fields: { error: error instanceof Error ? error.message : "unknown capture error" },
    });
    return undefined;
  }
}

function resolveLocalPiAgentDir(options: LocalReviewCommandOptions): string {
  const env = options.env ?? process.env;
  const configured = options.piAgentDir ?? env.PI_CODING_AGENT_DIR;
  return configured
    ? path.resolve(options.rootDir, configured)
    : path.join(env.HOME ?? os.homedir(), ".pi", "agent");
}

function requestedCaptureMode(
  env: NodeJS.ProcessEnv | undefined,
): "metadata" | "diagnostic" | undefined {
  const value = env?.PIPR_RUN_CAPTURE;
  if (value === undefined || value === "diagnostic") return "diagnostic";
  if (value === "metadata") return "metadata";
  if (value === "off") return undefined;
  throw new Error("PIPR_RUN_CAPTURE must be off, metadata, or diagnostic");
}
