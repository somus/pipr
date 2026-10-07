import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ciRunFromEnvironment, isNativeCiEnvironment } from "../hosts/ci-run.js";
import { type CodeHostId, codeHostIds } from "../hosts/selection.js";
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
import { createHostRunAdapter } from "./adapter.js";
import { runChangeRequestHostRunCommand } from "./change-request-entry.js";
import { runIssueCommentHostRunCommand } from "./command-entry.js";
import {
  classifyRunFailure,
  finishRecorderSafely,
  parseRunCaptureSetting,
  warnRunCaptureUnavailable,
} from "./commands-shared.js";
import type { HostRunServices } from "./composition.js";
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
  const adapter = createHostRunAdapter({
    env: options.env,
    host: options.host,
    hostAdapter: options.hostAdapter,
  });
  const log = createRuntimeLog({
    logSink: combineRuntimeLogSinks(options.logSink, recorder?.logSink),
    env: options.env,
    writesToSink: options.logSink !== undefined,
  });
  const services: HostRunServices = {
    rootDir: options.rootDir,
    configDir: options.configDir,
    env: options.env ?? process.env,
    dryRun: options.dryRun,
    adapter,
    log,
    eventPath: options.eventPath,
    piProviderModule: options.piProviderModule,
    piStoreRoot: options.piStoreRoot,
    piRunner: options.piRunner,
    secretRedactor: options.secretRedactor,
    runObserver: recorder ? recorder.observer : options.runObserver,
  };
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
      provider: ciRunFromEnvironment(adapter.id, options.env ?? process.env),
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
  const provider = ciRunFromEnvironment(state.adapter.id, options.env ?? process.env);
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

async function startHostedRecorder(
  options: HostRunCommandDependencyOptions,
): Promise<RunRecorder | undefined> {
  if (options.dryRun) return undefined;
  // A misspelled capture mode is operator error; fail before the run instead of silently dropping capture.
  parseRunCaptureSetting(options.env ?? process.env);
  try {
    return await createHostedRecorder(options);
  } catch (error) {
    warnRunCaptureUnavailable(options.logSink, error);
    return undefined;
  }
}

async function createHostedRecorder(
  options: HostRunCommandDependencyOptions,
): Promise<RunRecorder | undefined> {
  const env = options.env ?? process.env;
  const nativeCi = isNativeCiEnvironment(env);
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
  const value = parseRunCaptureSetting(env);
  if (value === "off") return { mode: undefined };
  if (value === "metadata") return { mode: "metadata" };
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

function bundleHost(host: string | undefined): CodeHostId | "local" {
  return host === "local" || codeHostIds.some((id) => id === host)
    ? (host as CodeHostId | "local")
    : "github";
}

async function captureHostedArtifacts(
  recorder: RunRecorder | undefined,
  result: Extract<HostRunCommandResult, { kind: "review" | "command-response" | "verifier" }>,
): Promise<void> {
  if (!recorder || result.kind === "review") return;
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
