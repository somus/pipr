import type { PiprRunContext, PiprRunSummary } from "@usepipr/sdk";
import { buildDiffManifest } from "../diff/diff.js";
import type { CodeHostAdapter, ReviewCommentReplyEvent } from "../hosts/types.js";
import { type PiRunStats, resolveProvider } from "../review/agent/review-run.js";
import { isPiprThreadActionReplyBody } from "../review/prior-state.js";
import { redactThreadActions } from "../review/publication-redaction.js";
import { stableReviewRunId } from "../review/run-identity.js";
import { reviewStatsForRuns } from "../review/task/task-output.js";
import { runInternalVerifier } from "../review/verifier.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import { hasRequiredRepositoryPermission } from "./entry-dispatch.js";
import { logEventContext, logPhase } from "./logging.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type {
  HostRunCommandDependencyOptions,
  HostRunCommandResult,
  TrustedRuntimeProject,
} from "./types.js";

export async function runReviewCommentReplyHostRunCommand(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeLog,
  reply: ReviewCommentReplyEvent,
): Promise<HostRunCommandResult> {
  const capabilities = reviewCommentReplyDispatchCapabilities(options, adapter);
  if (capabilities.kind === "ignored") {
    log.notice("event ignored", { reason: capabilities.reason });
    return capabilities;
  }
  const runnable = runnableReviewCommentReply(reply);
  if (runnable.kind === "ignored") {
    log.notice("event ignored", { reason: runnable.reason });
    return runnable;
  }
  const prepared = await prepareReviewCommentVerifier(options, adapter, reply, log);
  if (prepared.kind === "ignored") {
    log.notice("event ignored", { reason: prepared.reason });
    return prepared;
  }
  const result = await runReviewCommentVerifier(options, adapter, prepared, log);
  const publication = await logPhase(log, "publish verifier thread actions", async () =>
    capabilities.publishThreadActions({
      change: prepared.event,
      actions: result.threadActions,
      reviewedHeadSha: prepared.event.change.head.sha,
    }),
  );
  log.notice("verifier publication", {
    errors: publication?.errors.length ?? 0,
    threadActions: result.threadActions.length,
  });
  return {
    kind: "verifier",
    run: result.run,
    event: prepared.event,
    configSource: prepared.trustedRuntime.settings.source,
    errors: publication?.errors ?? [],
  };
}

function reviewCommentReplyDispatchCapabilities(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
):
  | { kind: "ignored"; reason: string }
  | {
      kind: "ready";
      publishThreadActions: NonNullable<
        NonNullable<CodeHostAdapter["publication"]>["publishThreadActions"]
      >;
    } {
  if (!adapter.capabilities.reviewCommentReplies || !adapter.capabilities.threadResolution) {
    return { kind: "ignored", reason: "host adapter does not support verifier replies" };
  }
  if (!adapter.publication?.publishThreadActions) {
    return { kind: "ignored", reason: "host adapter does not support verifier thread actions" };
  }
  if (options.dryRun) {
    return { kind: "ignored", reason: "PIPR_DRY_RUN=1; verifier dispatch skipped" };
  }
  return {
    kind: "ready",
    publishThreadActions: adapter.publication.publishThreadActions,
  };
}

type PreparedReviewCommentVerifier =
  | { kind: "ignored"; reason: string }
  | {
      kind: "prepared";
      reply: ReviewCommentReplyEvent & { parentCommentId: string };
      event: ChangeRequestEventContext;
      trustedRuntime: TrustedRuntimeProject;
    };

async function prepareReviewCommentVerifier(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  reply: ReviewCommentReplyEvent,
  log: RuntimeLog,
): Promise<PreparedReviewCommentVerifier> {
  if (!reply.parentCommentId) {
    return { kind: "ignored", reason: "review comment was not a reply" };
  }
  const loaded = await logPhase(log, "load change request", async () =>
    adapter.events.loadChangeRequest({
      repository: reply.repository,
      changeNumber: reply.changeNumber,
      workspace: reply.workspace,
      eventName: reply.eventName,
      action: reply.action,
      rawAction: reply.rawAction,
    }),
  );
  const event = parseChangeRequestEventContext({
    eventName: loaded.eventName ?? reply.eventName,
    action: loaded.action ?? reply.action,
    rawAction: loaded.rawAction ?? reply.rawAction,
    platform: { id: adapter.id },
    repository: loaded.repository,
    coordinates: loaded.coordinates,
    change: loaded.change,
    workspace: loaded.workspace ?? reply.workspace,
  });
  logEventContext(log, event);
  const trustedRuntime = await loadTrustedRuntimeForEvent(options, event, log);
  const config = trustedRuntime.settings.config;
  if (!config.publication.autoResolve.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve is disabled" };
  }
  if (!config.publication.autoResolve.userReplies.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve.userReplies is disabled" };
  }
  if (!(await verifierActorAllowed(adapter, event, reply, config))) {
    return { kind: "ignored", reason: "review comment reply actor is not allowed" };
  }
  await prepareTrustedHeadCheckout(options, adapter, trustedRuntime.settings.config, event, log);
  return {
    kind: "prepared",
    reply: { ...reply, parentCommentId: reply.parentCommentId },
    event,
    trustedRuntime,
  };
}

async function runReviewCommentVerifier(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  prepared: Exclude<PreparedReviewCommentVerifier, { kind: "ignored" }>,
  log: RuntimeLog,
) {
  const { event, reply, trustedRuntime } = prepared;
  const config = trustedRuntime.settings.config;
  registerVerifierProviderSecrets(config, options, log);
  const provider = resolveProvider(config, config.defaultProvider);
  const verifierProvider = resolveProvider(
    config,
    config.publication.autoResolve.model ?? config.defaultProvider,
  );
  const started = Date.now();
  const piRuns: PiRunStats[] = [];
  const runId = stableReviewRunId({
    event,
    selectedTasks: ["pipr-internal-verifier"],
    trustedConfigSha: trustedRuntime.trustedConfigSha,
    trustedConfigHash: trustedRuntime.trustedConfigHash,
    verifierInvocation: {
      mode: "user-reply",
      commentId: reply.commentId,
      parentCommentId: reply.parentCommentId,
    },
  });
  const runContext: PiprRunContext = Object.freeze({ id: runId, trigger: "verifier" });
  const threadContexts =
    (await adapter.comments?.loadInlineThreadContexts?.({ change: event })) ?? [];
  log.notice("verifier start", {
    mode: "user-reply",
    threadContexts: threadContexts.length,
    replyCommentId: reply.commentId,
    parentCommentId: reply.parentCommentId,
  });
  const diffManifest = buildDiffManifest({
    cwd: options.rootDir,
    baseSha: event.change.base.sha,
    headSha: event.change.head.sha,
  });
  try {
    await options.runObserver?.recordArtifact?.({
      kind: "diff-manifest",
      name: "diff-manifest.json",
      mediaType: "application/json",
      content: JSON.stringify(diffManifest, null, 2),
      sensitive: true,
    });
  } catch (error) {
    log.warning("run capture artifact failed", {
      kind: "diff-manifest",
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
  const result = await runInternalVerifier({
    workspace: options.rootDir,
    config,
    event,
    provider,
    verifierProvider,
    plan: trustedRuntime.plan,
    env: options.env,
    piExecutable: options.piExecutable,
    log,
    runObserver: options.runObserver,
    diffManifest,
    priorReviewState: await adapter.comments?.loadPriorReviewState?.({ change: event }),
    threadContexts,
    mode: {
      kind: "user-reply",
      reply: {
        commentId: reply.commentId,
        parentCommentId: reply.parentCommentId,
        body: reply.body,
        actor: reply.actor,
      },
      respondWhenStillValid: config.publication.autoResolve.userReplies.respondWhenStillValid,
    },
    run: runContext,
    piRunSink(run) {
      piRuns.push(run);
    },
  });
  const durationMs = Date.now() - started;
  const stats = reviewStatsForRuns(piRuns, durationMs);
  const run = verifierRunSummary({
    event,
    run: runContext,
    durationMs,
    providerModels: result.providerModels,
    fallbackModel: verifierProvider.model,
    stats,
  });
  return {
    ...result,
    run,
    threadActions: redactThreadActions({
      threadActions: result.threadActions,
      redactor: options.secretRedactor,
    }),
  };
}

function registerVerifierProviderSecrets(
  config: PiprConfig,
  options: HostRunCommandDependencyOptions,
  log: RuntimeLog,
): void {
  const env = options.env ?? process.env;
  for (const provider of config.providers) {
    const value = env[provider.apiKeyEnv];
    if (!value) continue;
    log.addSecret(value);
    options.secretRedactor?.addSecret(value);
    options.runObserver?.registerSecret?.(value);
  }
}

function verifierRunSummary(options: {
  event: ChangeRequestEventContext;
  run: PiprRunContext;
  durationMs: number;
  providerModels: string[];
  fallbackModel: string;
  stats: ReturnType<typeof reviewStatsForRuns>;
}): PiprRunSummary {
  const stats: Partial<NonNullable<ReturnType<typeof reviewStatsForRuns>>> = options.stats ?? {};
  const {
    agentRuns = 0,
    inputTokens = 0,
    outputTokens = 0,
    costUsd = 0,
    usageStatus = "unavailable",
  } = stats;
  const models = options.providerModels.length ? options.providerModels : [options.fallbackModel];
  return {
    ...options.run,
    baseSha: options.event.change.base.sha,
    headSha: options.event.change.head.sha,
    tasks: ["pipr-internal-verifier"],
    durationMs: options.durationMs,
    models,
    agentRuns,
    inputTokens,
    outputTokens,
    costUsd,
    usageStatus,
  };
}

function runnableReviewCommentReply(
  reply: ReviewCommentReplyEvent,
): { kind: "runnable" } | { kind: "ignored"; reason: string } {
  if (reply.action !== "created") {
    return { kind: "ignored", reason: `review comment action '${reply.action}' is not supported` };
  }
  if (!reply.parentCommentId) {
    return { kind: "ignored", reason: "review comment was not a reply" };
  }
  if (reply.actor === "github-actions[bot]") {
    return { kind: "ignored", reason: "review comment reply was authored by pipr" };
  }
  if (isPiprThreadActionReplyBody(reply.body)) {
    return { kind: "ignored", reason: "review comment reply was authored by pipr" };
  }
  return { kind: "runnable" };
}

async function verifierActorAllowed(
  adapter: CodeHostAdapter,
  event: ChangeRequestEventContext,
  reply: ReviewCommentReplyEvent,
  config: PiprConfig,
): Promise<boolean> {
  const allowed = config.publication.autoResolve.userReplies.allowedActors;
  if (allowed === "any") {
    return true;
  }
  if (allowed === "author-or-write" && event.change.author?.login === reply.actor) {
    return true;
  }
  const permission = await adapter.permissions.getRepositoryPermission({
    change: event,
    actor: reply.actor,
  });
  return hasRequiredRepositoryPermission(permission, "write");
}
