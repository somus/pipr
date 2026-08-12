import type { PiprRunContext, PiprRunSummary } from "@usepipr/sdk";
import { buildDiffManifest } from "../diff/diff.js";
import type { CodeHostAdapter, ReviewCommentReplyEvent } from "../hosts/types.js";
import { resolveProvider } from "../review/agent/prompt-assembly.js";
import type { PiRunStats } from "../review/agent/review-run-types.js";
import { isPiprThreadActionReplyBody } from "../review/prior-state.js";
import { redactThreadActions } from "../review/publication-redaction.js";
import { stableReviewRunId } from "../review/run-identity.js";
import { reviewStatsForRuns, runSummaryStatsFields } from "../review/task/task-output.js";
import { runInternalVerifier } from "../review/verifier.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import type { HostRunPorts, HostRunServices } from "./composition.js";
import { hasRequiredRepositoryPermission } from "./entry-dispatch.js";
import { logEventContext, logPhase } from "./logging.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type { HostRunCommandResult, TrustedRuntimeProject } from "./types.js";

export async function runReviewCommentReplyHostRunCommand(
  services: HostRunServices,
  reply: ReviewCommentReplyEvent,
): Promise<HostRunCommandResult> {
  const capabilities = reviewCommentReplyDispatchCapabilities(services);
  if (capabilities.kind === "ignored") {
    services.log.notice("event ignored", { reason: capabilities.reason });
    return capabilities;
  }
  const runnable = runnableReviewCommentReply(reply);
  if (runnable.kind === "ignored") {
    services.log.notice("event ignored", { reason: runnable.reason });
    return runnable;
  }
  const prepared = await prepareReviewCommentVerifier(services, reply);
  if (prepared.kind === "ignored") {
    services.log.notice("event ignored", { reason: prepared.reason });
    return prepared;
  }
  const result = await runReviewCommentVerifier(services, prepared);
  const publication = await logPhase(services.log, "publish verifier thread actions", async () =>
    capabilities.publishThreadActions({
      change: prepared.event,
      actions: result.threadActions,
      reviewedHeadSha: prepared.event.change.head.sha,
    }),
  );
  services.log.notice("verifier publication", {
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

function reviewCommentReplyDispatchCapabilities(services: HostRunServices):
  | { kind: "ignored"; reason: string }
  | {
      kind: "ready";
      publishThreadActions: NonNullable<
        NonNullable<CodeHostAdapter["publication"]>["publishThreadActions"]
      >;
    } {
  if (
    !services.adapter.capabilities.reviewCommentReplies ||
    !services.adapter.capabilities.threadResolution
  ) {
    return { kind: "ignored", reason: "host adapter does not support verifier replies" };
  }
  if (!services.adapter.publication?.publishThreadActions) {
    return { kind: "ignored", reason: "host adapter does not support verifier thread actions" };
  }
  if (services.dryRun) {
    return { kind: "ignored", reason: "PIPR_DRY_RUN=1; verifier dispatch skipped" };
  }
  return {
    kind: "ready",
    publishThreadActions: services.adapter.publication.publishThreadActions,
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
  services: HostRunServices,
  reply: ReviewCommentReplyEvent,
): Promise<PreparedReviewCommentVerifier> {
  if (!reply.parentCommentId) {
    return { kind: "ignored", reason: "review comment was not a reply" };
  }
  const loaded = await logPhase(services.log, "load change request", async () =>
    services.adapter.events.loadChangeRequest({
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
    platform: { id: services.adapter.id },
    repository: loaded.repository,
    coordinates: loaded.coordinates,
    change: loaded.change,
    workspace: loaded.workspace ?? reply.workspace,
  });
  logEventContext(services.log, event);
  const trustedRuntime = await loadTrustedRuntimeForEvent(services, event, services.log);
  const config = trustedRuntime.settings.config;
  if (!config.publication.autoResolve.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve is disabled" };
  }
  if (!config.publication.autoResolve.userReplies.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve.userReplies is disabled" };
  }
  if (!(await verifierActorAllowed(services.adapter, event, reply, config))) {
    return { kind: "ignored", reason: "review comment reply actor is not allowed" };
  }
  await prepareTrustedHeadCheckout(
    services,
    services.adapter,
    trustedRuntime.settings.config,
    event,
    services.log,
  );
  return {
    kind: "prepared",
    reply: { ...reply, parentCommentId: reply.parentCommentId },
    event,
    trustedRuntime,
  };
}

async function runReviewCommentVerifier(
  services: HostRunServices,
  prepared: Exclude<PreparedReviewCommentVerifier, { kind: "ignored" }>,
) {
  const { event, reply, trustedRuntime } = prepared;
  const config = trustedRuntime.settings.config;
  registerVerifierProviderSecrets(config, services, services.log);
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
    (await services.adapter.comments?.loadInlineThreadContexts?.({ change: event })) ?? [];
  services.log.notice("verifier start", {
    mode: "user-reply",
    threadContexts: threadContexts.length,
    replyCommentId: reply.commentId,
    parentCommentId: reply.parentCommentId,
  });
  const diffManifest = buildDiffManifest({
    cwd: services.rootDir,
    baseSha: event.change.base.sha,
    headSha: event.change.head.sha,
  });
  try {
    await services.runObserver?.recordArtifact?.({
      kind: "diff-manifest",
      name: "diff-manifest.json",
      mediaType: "application/json",
      content: JSON.stringify(diffManifest, null, 2),
      sensitive: true,
    });
  } catch (error) {
    services.log.warning("run capture artifact failed", {
      kind: "diff-manifest",
      error: error instanceof Error ? error.message : "unknown capture error",
    });
  }
  const result = await runInternalVerifier({
    workspace: services.rootDir,
    config,
    event,
    provider,
    verifierProvider,
    plan: trustedRuntime.plan,
    env: services.env,
    piExecutable: services.piExecutable,
    piRunner: services.piRunner,
    log: services.log,
    runObserver: services.runObserver,
    diffManifest,
    priorReviewState: await services.adapter.comments?.loadPriorReviewState?.({ change: event }),
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
      redactor: services.secretRedactor,
    }),
  };
}

function registerVerifierProviderSecrets(
  config: PiprConfig,
  ports: Pick<HostRunPorts, "secretRedactor" | "runObserver"> & { env: NodeJS.ProcessEnv },
  log: RuntimeLog,
): void {
  for (const provider of config.providers) {
    if (!provider.apiKeyEnv) continue;
    const value = ports.env[provider.apiKeyEnv];
    if (!value) continue;
    log.addSecret(value);
    ports.secretRedactor?.addSecret(value);
    ports.runObserver?.registerSecret?.(value);
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
  const models = options.providerModels.length ? options.providerModels : [options.fallbackModel];
  return {
    ...options.run,
    baseSha: options.event.change.base.sha,
    headSha: options.event.change.head.sha,
    tasks: ["pipr-internal-verifier"],
    durationMs: options.durationMs,
    models,
    ...runSummaryStatsFields(options.stats),
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
