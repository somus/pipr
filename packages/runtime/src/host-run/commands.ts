import path from "node:path";
import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { CodeHostHttpError } from "../hosts/http.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import type { CodeHostAdapter, CodeHostEvent } from "../hosts/types.js";
import {
  combineRuntimeLogSinks,
  type RunFailureCategory,
  type RunRecorder,
  startFileRunRecorder,
} from "../observability/recorder.js";
import { PublicationError } from "../review/publication-result.js";
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

async function finishRecorderSafely(
  recorder: RunRecorder | undefined,
  log: ReturnType<typeof createRuntimeLog> | undefined,
  result: Parameters<RunRecorder["finish"]>[0],
  onFinalized?: NonNullable<HostRunCommandOptions["onRunBundleFinalized"]>,
): Promise<void> {
  if (!recorder) return;
  try {
    await recorder.finish(result);
    await onFinalized?.({
      executionId: recorder.executionId,
      directory: recorder.directory,
      kind: result.kind,
      outcome: result.outcome,
      ...(result.repository ? { repository: result.repository } : {}),
    });
  } catch (error) {
    log?.warning("run capture failed", {
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
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
  const recorder = await startHostedRecorder(options);
  const runOptions = recorder ? { ...options, runObserver: recorder.observer } : options;
  const log = createRuntimeLog({
    logSink: combineRuntimeLogSinks(options.logSink, recorder?.logSink),
    env: options.env,
    writesToSink: options.logSink !== undefined,
  });
  let adapter: CodeHostAdapter | undefined;
  let event: CodeHostEvent | undefined;
  let failureCategory: RunFailureCategory = "startup";
  try {
    const result = await log.group("pipr host run", async () => {
      log.notice("host run start", {
        dryRun: options.dryRun,
        root: options.rootDir,
        configDir: options.configDir,
      });
      adapter = createHostRunAdapter(runOptions);
      failureCategory = "workspace";
      await logPhase(log, "workspace", async () => {
        adapter?.workspace.ensureWorkspaceSafeDirectory?.({
          rootDir: options.rootDir,
          env: runOptions.env,
        });
      });
      failureCategory = "event";
      event = await logPhase(log, "parse event", async () =>
        adapter?.events.parseEvent({
          eventPath: runOptions.eventPath,
          env: runOptions.env ?? process.env,
          workspace: runOptions.rootDir,
        }),
      );
      if (!event) throw new Error("Code host adapter did not return an event");
      log.notice("event dispatch", { kind: event.kind });
      failureCategory = "dispatch";
      switch (event.kind) {
        case "ignored":
          return event;
        case "command-comment":
          return await runIssueCommentHostRunCommand(runOptions, adapter, log, event.comment);
        case "review-comment-reply":
          return await runReviewCommentReplyHostRunCommand(runOptions, adapter, log, event.reply);
        case "change-request":
          return await runChangeRequestHostRunCommand(runOptions, adapter, log, event.change);
      }
    });
    if (!isObservableHostResult(result)) {
      await recorder?.discard();
      return result;
    }
    if (!adapter) throw new Error("Code host adapter was not initialized");
    await captureHostedArtifacts(recorder, result);
    await finishRecorderSafely(
      recorder,
      log,
      {
        kind: hostResultKind(result),
        outcome: "succeeded",
        workId: result.kind === "review" ? result.review.run.id : result.run.id,
        ...(result.kind === "review"
          ? {
              configVersion: result.review.publicationPlan.metadata.configVersion,
              configHash: result.review.publicationPlan.metadata.trustedConfigHash,
            }
          : {}),
        repository: bundleRepository(result.event, adapter.id),
        provider: providerRun(options.env ?? process.env, adapter.id, result.event.repository.slug),
      },
      options.onRunBundleFinalized,
    );
    return result;
  } catch (error) {
    await finishRecorderSafely(
      recorder,
      log,
      {
        kind: hostEventKind(event),
        outcome: "failed",
        failureCategory: classifyRunFailure(error, failureCategory),
        ...(event && event.kind !== "ignored"
          ? { repository: partialBundleRepository(event, adapter?.id) }
          : {}),
        ...(adapter ? { provider: providerRun(options.env ?? process.env, adapter.id) } : {}),
      },
      options.onRunBundleFinalized,
    );
    throw error;
  }
}

function classifyRunFailure(error: unknown, fallback: RunFailureCategory): RunFailureCategory {
  if (isAuthenticationFailure(error)) return "auth";
  const message = error instanceof Error ? error.message : String(error);
  if (/head changed|stale head/i.test(message)) return "stale-head";
  if (error instanceof PublicationError) return "publication";
  return messageFailureCategory(message) ?? fallback;
}

function isAuthenticationFailure(error: unknown): boolean {
  if (error instanceof CodeHostHttpError) return error.status === 401 || error.status === 403;
  const cause = error instanceof PublicationError ? error.cause : undefined;
  return cause instanceof CodeHostHttpError && (cause.status === 401 || cause.status === 403);
}

function messageFailureCategory(message: string): RunFailureCategory | undefined {
  const patterns: Array<[RegExp, RunFailureCategory]> = [
    [/pi timed out|agent timed out/i, "agent-timeout"],
    [/pi output failed schema validation|invalid (?:agent|review) output/i, "invalid-output"],
    [/pi (?:exited|failed)|agent (?:exited|failed)/i, "agent-exit"],
    [/diff manifest|git diff|merge base/i, "diff"],
    [/review validation|finding validation/i, "validation"],
    [/publish|publication/i, "publication"],
  ];
  return patterns.find(([pattern]) => pattern.test(message))?.[1];
}

async function startHostedRecorder(
  options: HostRunCommandDependencyOptions,
): Promise<RunRecorder | undefined> {
  if (options.dryRun) return undefined;
  try {
    const env = options.env ?? process.env;
    const mode = requestedCaptureMode(env);
    if (!mode) return undefined;
    return await startFileRunRecorder({
      rootDirectory: env.PIPR_RUN_STORE_DIR ?? path.join(options.rootDir, ".pipr-runs"),
      env,
      mode,
      externalUpload: isNativeCi(env) ? "pending" : "not-configured",
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

function requestedCaptureMode(
  env: NodeJS.ProcessEnv | undefined,
): "metadata" | "diagnostic" | undefined {
  const value = env?.PIPR_RUN_CAPTURE;
  if (value === undefined || value === "diagnostic") return "diagnostic";
  if (value === "metadata") return "metadata";
  if (value === "off") return undefined;
  throw new Error("PIPR_RUN_CAPTURE must be off, metadata, or diagnostic");
}

function isObservableHostResult(
  result: HostRunCommandResult,
): result is Extract<HostRunCommandResult, { kind: "review" | "command-response" | "verifier" }> {
  return (
    result.kind === "review" || result.kind === "command-response" || result.kind === "verifier"
  );
}

function hostResultKind(
  result: Extract<HostRunCommandResult, { kind: "review" | "command-response" | "verifier" }>,
): "review" | "command" | "verifier" {
  if (result.kind === "command-response") return "command";
  return result.kind;
}

function hostEventKind(
  event: CodeHostEvent | undefined,
): "review" | "command" | "verifier" | "startup" {
  if (event?.kind === "change-request") return "review";
  if (event?.kind === "command-comment") return "command";
  if (event?.kind === "review-comment-reply") return "verifier";
  return "startup";
}

function bundleRepository(
  event: import("../types.js").ChangeRequestEventContext,
  host: string,
): import("@usepipr/sdk").RunBundleManifest["repository"] {
  return {
    host: bundleHost(host),
    repository: event.repository.slug,
    changeNumber: event.change.number,
    ...(event.change.url ? { changeUrl: event.change.url } : {}),
    baseSha: event.change.base.sha,
    headSha: event.change.head.sha,
  };
}

function partialBundleRepository(
  event: Exclude<CodeHostEvent, { kind: "ignored" }>,
  host: string | undefined,
): import("@usepipr/sdk").RunBundleManifest["repository"] {
  if (event.kind === "change-request")
    return bundleRepository(event.change, host ?? event.change.platform.id);
  return {
    host: bundleHost(host),
    repository:
      event.kind === "command-comment"
        ? event.comment.repository.slug
        : event.reply.repository.slug,
    changeNumber:
      event.kind === "command-comment" ? event.comment.changeNumber : event.reply.changeNumber,
  };
}

function bundleHost(
  host: string | undefined,
): "github" | "gitlab" | "azure-devops" | "bitbucket" | "local" {
  if (host === "gitlab" || host === "azure-devops" || host === "bitbucket" || host === "local") {
    return host;
  }
  return "github";
}

function providerRun(
  env: NodeJS.ProcessEnv,
  host: string,
  repository?: string,
): import("@usepipr/sdk").RunBundleManifest["provider"] | undefined {
  switch (host) {
    case "github":
      return githubProviderRun(env, repository);
    case "gitlab":
      return gitlabProviderRun(env);
    case "azure-devops":
      return azureProviderRun(env);
    case "bitbucket":
      return bitbucketProviderRun(env);
    default:
      return undefined;
  }
}

function githubProviderRun(env: NodeJS.ProcessEnv, repository: string | undefined) {
  const runId = env.GITHUB_RUN_ID;
  const runUrl =
    runId && repository && env.GITHUB_SERVER_URL
      ? `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${runId}`
      : undefined;
  return compactProviderRun({ runId, jobId: env.GITHUB_JOB, runUrl });
}

function gitlabProviderRun(env: NodeJS.ProcessEnv) {
  return compactProviderRun({
    runId: env.CI_PIPELINE_ID,
    jobId: env.CI_JOB_ID,
    runUrl: env.CI_PIPELINE_URL,
    jobUrl: env.CI_JOB_URL,
  });
}

function azureProviderRun(env: NodeJS.ProcessEnv) {
  const runId = env.BUILD_BUILDID;
  const runUrl =
    runId && env.SYSTEM_COLLECTIONURI && env.SYSTEM_TEAMPROJECT
      ? `${env.SYSTEM_COLLECTIONURI}${encodeURIComponent(env.SYSTEM_TEAMPROJECT)}/_build/results?buildId=${runId}`
      : undefined;
  return compactProviderRun({ runId, jobId: env.SYSTEM_JOBID, runUrl });
}

function bitbucketProviderRun(env: NodeJS.ProcessEnv) {
  const runUrl =
    env.BITBUCKET_GIT_HTTP_ORIGIN && env.BITBUCKET_BUILD_NUMBER
      ? `${env.BITBUCKET_GIT_HTTP_ORIGIN}/pipelines/results/${env.BITBUCKET_BUILD_NUMBER}`
      : undefined;
  return compactProviderRun({
    runId: env.BITBUCKET_PIPELINE_UUID ?? env.BITBUCKET_BUILD_NUMBER,
    jobId: env.BITBUCKET_STEP_UUID,
    runUrl,
  });
}

function compactProviderRun(
  value: NonNullable<import("@usepipr/sdk").RunBundleManifest["provider"]>,
): import("@usepipr/sdk").RunBundleManifest["provider"] | undefined {
  const compact = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
  return Object.keys(compact).length > 0 ? compact : undefined;
}

function isNativeCi(env: NodeJS.ProcessEnv): boolean {
  return (
    env.GITHUB_ACTIONS === "true" ||
    env.GITLAB_CI === "true" ||
    env.TF_BUILD === "True" ||
    env.TF_BUILD === "true" ||
    env.BITBUCKET_BUILD_NUMBER !== undefined
  );
}

async function captureHostedArtifacts(
  recorder: RunRecorder | undefined,
  result: Extract<HostRunCommandResult, { kind: "review" | "command-response" | "verifier" }>,
): Promise<void> {
  if (!recorder) return;
  if (result.kind === "review") {
    return;
  }
  await recorder.addArtifact({
    kind: "output",
    name: result.kind === "verifier" ? "verifier-output.json" : "command-output.json",
    mediaType: "application/json",
    content: JSON.stringify(
      result.kind === "verifier"
        ? { errors: result.errors }
        : { response: result.response, publication: result.publication },
      null,
      2,
    ),
    sensitive: true,
  });
}
