import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadRuntimeProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import { startFileRunRecorder } from "../observability/file-run-recorder.js";
import type { RunFailureCategory, RunRecorder } from "../observability/recorder-types.js";
import { combineRuntimeLogSinks } from "../observability/runtime-log-sinks.js";
import { createFindingLedger } from "../review/finding-ledger.js";
import { selectLocalReviewTasks } from "../review/task/select-runtime-tasks.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import { createRuntimeLog, shortSha } from "../shared/logging.js";
import {
  classifyRunFailure,
  finishRecorderSafely,
  parseRunCaptureSetting,
  recordFindingLedgerSafely,
  warnRunCaptureUnavailable,
} from "./commands-shared.js";
import { logConfigWarnings, logEventContext, runtimeSummaryFields } from "./logging.js";
import type { LocalReviewCommandOptions, LocalReviewCommandResult } from "./types.js";

/** Runs configured change-request tasks against local Git base and head revisions. */
export async function runLocalReviewCommand(
  options: LocalReviewCommandOptions,
): Promise<LocalReviewCommandResult> {
  const recorder = await startLocalRecorder(options);
  const runOptions = recorder ? { ...options, runObserver: recorder.observer } : options;
  const findingLedger = localFindingLedger(recorder);
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
      base: shortSha(options.baseSha),
      head: shortSha(options.headSha),
    });
    const runtime = await loadRuntimeProject({
      ...runOptions,
      requireProviderEnv: false,
    });
    log?.notice("local config loaded", {
      source: runtime.settings.source,
      ...runtimeSummaryFields(runtime),
    });
    if (log) logConfigWarnings(log, runtime.settings.warnings);
    failureCategory = "dispatch";
    reviewStarted = true;
    const selectedTasks = selectLocalReviewTasks(runtime.plan);
    const includeWorkingTree = options.headSha === undefined;
    const headSha =
      options.headSha ??
      runGitCommand(["rev-parse", "HEAD"], options.rootDir, { env: options.env }).trim();
    localRepository = {
      host: "local",
      repository: path.basename(options.rootDir),
      baseSha: options.baseSha,
      headSha,
    };
    const event = createLocalChangeRequestEvent({
      rootDir: options.rootDir,
      baseSha: options.baseSha,
      headSha,
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
      env: runOptions.env,
      plan: runtime.plan,
      versionCompatibility: runtime.versionCompatibility,
      selectedTasks,
      emptyTasksReason: "No change-request tasks are configured for local review",
      piProviderModule: runOptions.piProviderModule,
      piAuthFile: resolveLocalPiAuthFile(runOptions),
      piRunner: runOptions.piRunner,
      structuralHeadRef: includeWorkingTree ? undefined : headSha,
      diffManifestBuilder: includeWorkingTree
        ? (diffOptions) => buildDiffManifest({ ...diffOptions, includeWorkingTree: true })
        : undefined,
      log,
      taskLog: options.taskLog,
      runTrigger: "local",
      runObserver: runOptions.runObserver,
      findingLedger,
    });
    if (result.kind === "command-response") {
      throw new Error("command response result is only supported for issue_comment commands");
    }
    log?.notice("local review complete", localReviewCompleteFields(result));
    await recordFindingLedgerSafely(recorder, findingLedger, log);
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

/** Shares the Run Bundle's execution ID, or a fresh one when capture is off. */
function localFindingLedger(recorder: RunRecorder | undefined) {
  return createFindingLedger({
    executionId: recorder?.executionId ?? randomBytes(16).toString("hex"),
  });
}

function localReviewCompleteFields(result: LocalReviewCommandResult) {
  const review = result.kind === "review" ? result : undefined;
  return {
    kind: result.kind,
    taskChecks: result.taskChecks.length,
    validFindings: review?.validated.validFindings.length,
    droppedFindings: review?.validated.droppedFindings.length,
    inlineDrafts: review?.inlineCommentDrafts.length,
  };
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
    const mode = parseRunCaptureSetting(env) ?? "diagnostic";
    if (mode === "off") return undefined;
    return await startFileRunRecorder({
      rootDirectory: options.traceDirectory,
      env,
      mode,
    });
  } catch (error) {
    warnRunCaptureUnavailable(options.logSink, error);
    return undefined;
  }
}

function resolveLocalPiAuthFile(options: LocalReviewCommandOptions): string {
  const env = options.env ?? process.env;
  if (options.piAuthFile) return path.resolve(options.rootDir, options.piAuthFile);
  const agentDir = env.PI_CODING_AGENT_DIR
    ? path.resolve(options.rootDir, env.PI_CODING_AGENT_DIR)
    : path.join(env.HOME ?? os.homedir(), ".pi", "agent");
  return path.join(agentDir, "auth.json");
}
