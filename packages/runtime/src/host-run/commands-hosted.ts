import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CodeHostAdapter, CodeHostEvent } from "../hosts/types.js";
import { startFileRunRecorder } from "../observability/file-run-recorder.js";
import {
  parseRunBundleRecipients,
  validateRunBundleRecipients,
} from "../observability/protected-package.js";
import type { RunFailureCategory, RunRecorder } from "../observability/recorder-types.js";
import { combineRuntimeLogSinks } from "../observability/runtime-log-sinks.js";
import { maximumRunBundleBytes } from "../observability/types.js";
import { ReviewProgressSupersededError } from "../review/progress.js";
import { createRuntimeLog, type RuntimeLog } from "../shared/logging.js";
import { createKnownSecretRedactor } from "../shared/secret-redactor.js";
import { runChangeRequestHostRunCommand } from "./change-request-entry.js";
import { runIssueCommentHostRunCommand } from "./command-entry.js";
import { classifyRunFailure, finishRecorderSafely } from "./commands-shared.js";
import {
  composeHostRunPorts,
  composeHostRunServices,
  composeHostRunWorkspace,
  type HostRunServices,
} from "./composition.js";
import { logPhase } from "./logging.js";
import type {
  HostRunCommandDependencyOptions,
  HostRunCommandOptions,
  HostRunCommandResult,
} from "./types.js";
import { runReviewCommentReplyHostRunCommand } from "./verifier-entry.js";

/** Composition root: wire adapters, recorder, and ports once, then dispatch. */
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
  const workspace = composeHostRunWorkspace(options);
  const ports = composeHostRunPorts(options, {
    ...(recorder ? { runObserver: recorder.observer } : {}),
  });
  const log = createRuntimeLog({
    logSink: combineRuntimeLogSinks(options.logSink, recorder?.logSink),
    env: options.env,
    writesToSink: options.logSink !== undefined,
  });
  const services = composeHostRunServices({ workspace, ports, log });
  const state: HostRunState = { failureCategory: "startup", adapter: services.adapter };
  try {
    const result = await log.group("pipr host run", async () => executeHostRun(services, state));
    if (!isObservableHostResult(result)) {
      await recorder?.discard();
      return result;
    }
    await captureHostedArtifacts(recorder, result);
    await finishSuccessfulHostedRecorder(recorder, log, options, result, services.adapter);
    return result;
  } catch (error) {
    const superseded = await finishFailedHostedRecorder(recorder, log, options, state, error);
    if (superseded) return { kind: "ignored", reason: superseded.message };
    throw error;
  }
}

type HostRunState = {
  adapter: CodeHostAdapter;
  event?: CodeHostEvent;
  failureCategory: RunFailureCategory;
};

type ObservableHostResult = Extract<
  HostRunCommandResult,
  { kind: "review" | "command-response" | "verifier" }
>;

async function executeHostRun(
  services: HostRunServices,
  state: HostRunState,
): Promise<HostRunCommandResult> {
  services.log.notice("host run start", {
    dryRun: services.dryRun,
    root: services.rootDir,
    configDir: services.configDir,
  });
  state.failureCategory = "workspace";
  await logPhase(services.log, "workspace", async () => {
    services.adapter.workspace.ensureWorkspaceSafeDirectory?.({
      rootDir: services.rootDir,
      env: services.env,
    });
  });
  state.failureCategory = "event";
  const event = await logPhase(services.log, "parse event", async () =>
    services.adapter.events.parseEvent({
      eventPath: services.eventPath,
      env: services.env,
      workspace: services.rootDir,
    }),
  );
  state.event = event;
  services.log.notice("event dispatch", { kind: event.kind });
  state.failureCategory = "dispatch";
  switch (event.kind) {
    case "ignored":
      return event;
    case "command-comment":
      return await runIssueCommentHostRunCommand(services, event.comment);
    case "review-comment-reply":
      return await runReviewCommentReplyHostRunCommand(services, event.reply);
    case "change-request":
      return await runChangeRequestHostRunCommand(services, event.change);
  }
}

async function finishSuccessfulHostedRecorder(
  recorder: RunRecorder | undefined,
  log: RuntimeLog,
  options: HostRunCommandDependencyOptions,
  result: ObservableHostResult,
  adapter: CodeHostAdapter,
): Promise<void> {
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
}

async function finishFailedHostedRecorder(
  recorder: RunRecorder | undefined,
  log: RuntimeLog,
  options: HostRunCommandDependencyOptions,
  state: HostRunState,
  error: unknown,
): Promise<ReviewProgressSupersededError | undefined> {
  const superseded = error instanceof ReviewProgressSupersededError ? error : undefined;
  const result: Parameters<RunRecorder["finish"]>[0] = {
    kind: hostEventKind(state.event),
    outcome: "failed",
    failureCategory: classifyRunFailure(error, state.failureCategory),
  };
  if (superseded) {
    result.outcome = "partial";
    result.failureCategory = "stale-head";
  }
  const repository = failedBundleRepository(state);
  if (repository) result.repository = repository;
  const provider = failedBundleProvider(options, state);
  if (provider) result.provider = provider;
  await finishRecorderSafely(recorder, log, result, options.onRunBundleFinalized);
  return superseded;
}

function failedBundleRepository(
  state: HostRunState,
): import("@usepipr/sdk").RunBundleManifest["repository"] | undefined {
  if (!state.event || state.event.kind === "ignored") return undefined;
  return partialBundleRepository(state.event, state.adapter.id);
}

function failedBundleProvider(
  options: HostRunCommandDependencyOptions,
  state: HostRunState,
): import("@usepipr/sdk").RunBundleManifest["provider"] | undefined {
  return providerRun(options.env ?? process.env, state.adapter.id);
}

async function startHostedRecorder(
  options: HostRunCommandDependencyOptions,
): Promise<RunRecorder | undefined> {
  if (options.dryRun) return undefined;
  try {
    return await createHostedRecorder(options);
  } catch (error) {
    options.logSink?.log({
      level: "warning",
      event: "run capture unavailable",
      fields: { error: error instanceof Error ? error.message : "unknown capture error" },
    });
    return undefined;
  }
}

async function createHostedRecorder(
  options: HostRunCommandDependencyOptions,
): Promise<RunRecorder | undefined> {
  const env = options.env ?? process.env;
  const nativeCi = isNativeCi(env);
  const githubActions = env.GITHUB_ACTIONS === "true";
  const capture = await requestedHostedCaptureMode(env, nativeCi);
  if (!capture.mode) return undefined;
  publishCaptureProtectionWarning(options, capture.warning);
  const rootDirectory = nativeCi
    ? await mkdtemp(path.join(os.tmpdir(), "pipr-run-capture-"))
    : (env.PIPR_RUN_STORE_DIR ?? path.join(options.rootDir, ".pipr-runs"));
  return await startFileRunRecorder({
    rootDirectory,
    env,
    mode: capture.mode,
    externalUpload: githubActions ? "pending" : "not-configured",
    ...(nativeCi && capture.mode === "diagnostic"
      ? { maxBytes: maximumRunBundleBytes - 4 * 1024 * 1024 }
      : {}),
  });
}

function publishCaptureProtectionWarning(
  options: HostRunCommandDependencyOptions,
  warning: "recipients-missing" | "recipients-invalid" | undefined,
): void {
  if (!warning) return;
  options.logSink?.log({
    level: "warning",
    event: "run capture protection unavailable",
    fields: { status: warning },
  });
}

async function requestedHostedCaptureMode(
  env: NodeJS.ProcessEnv,
  nativeCi: boolean,
): Promise<{
  mode: "metadata" | "diagnostic" | undefined;
  warning?: "recipients-missing" | "recipients-invalid";
}> {
  const value = env.PIPR_RUN_CAPTURE;
  if (value === "off") return { mode: undefined };
  if (value === "metadata") return { mode: "metadata" };
  if (value !== undefined && value !== "diagnostic") {
    throw new Error("PIPR_RUN_CAPTURE must be off, metadata, or diagnostic");
  }
  if (!nativeCi) return { mode: "diagnostic" };
  const recipients = parseRunBundleRecipients(env.PIPR_RUN_AGE_RECIPIENTS);
  if (recipients.length === 0) {
    return {
      mode: "metadata",
      ...(value === "diagnostic" ? { warning: "recipients-missing" as const } : {}),
    };
  }
  try {
    await validateRunBundleRecipients(recipients);
    return { mode: "diagnostic" };
  } catch {
    return { mode: "metadata", warning: "recipients-invalid" };
  }
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
): "github" | "gitlab" | "azure-devops" | "bitbucket" | "gitea" | "forgejo" | "codeberg" | "local" {
  if (
    host === "gitlab" ||
    host === "azure-devops" ||
    host === "bitbucket" ||
    host === "gitea" ||
    host === "forgejo" ||
    host === "codeberg" ||
    host === "local"
  ) {
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
    case "gitea":
      return giteaProviderRun(env, "GITHUB", repository);
    case "forgejo":
    case "codeberg":
      return giteaProviderRun(env, "FORGEJO", repository);
    default:
      return undefined;
  }
}

function giteaProviderRun(
  env: NodeJS.ProcessEnv,
  prefix: "GITHUB" | "FORGEJO",
  repository: string | undefined,
) {
  const runId = env[`${prefix}_RUN_ID`];
  const serverUrl = env[`${prefix}_SERVER_URL`];
  const runUrl =
    runId && repository && serverUrl
      ? `${serverUrl.replace(/\/+$/, "")}/${repository}/actions/runs/${runId}`
      : undefined;
  return compactProviderRun({
    runId,
    jobId: env[`${prefix}_JOB`],
    runUrl,
  });
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
    env.BITBUCKET_BUILD_NUMBER !== undefined ||
    env.GITEA_ACTIONS === "true" ||
    env.FORGEJO_ACTIONS === "true"
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
