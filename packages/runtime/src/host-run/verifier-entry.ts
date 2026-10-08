import type { FindingActorPermission, PiprRunContext, PiprRunSummary } from "@usepipr/sdk";
import { registerProviderSecrets } from "../config/provider-credentials.js";
import { buildDiffManifest } from "../diff/diff.js";
import type { CodeHostAdapter, ReviewCommentReplyEvent } from "../hosts/types.js";
import { recordArtifactSafely } from "../observability/capture-sinks.js";
import type { InlineThreadContext, PriorReviewState } from "../publication/types.js";
import { resolveProvider } from "../review/agent/prompt-assembly.js";
import type { PiRunStats } from "../review/agent/review-run-types.js";
import { isPiprThreadActionReplyBody } from "../review/comment-markers.js";
import {
  type FindingOutcomeEmission,
  findingLedgerContext,
  findingOutcomeAnchors,
  verifierVerdictOutcome,
} from "../review/finding-ledger.js";
import { priorFindingAttribution } from "../review/prior-state.js";
import { redactThreadActions } from "../review/publication-redaction.js";
import { reviewStatsForRuns, runSummaryStatsFields } from "../review/review-stats.js";
import { stableReviewRunId } from "../review/run-identity.js";
import { replyThreadContext, replyThreadKey, runInternalVerifier } from "../review/verifier.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import type { HostRunPorts, HostRunServices } from "./composition.js";
import { hasRequiredRepositoryPermission } from "./entry-dispatch.js";
import { ignore, logPhase } from "./logging.js";
import { changeRequestPiStoreDir } from "./pi-store.js";
import {
  loadCommentChangeRequest,
  loadTrustedRuntimeForEvent,
  prepareTrustedHeadCheckout,
} from "./trusted-runtime.js";
import type { HostRunCommandResult, TrustedRuntimeProject } from "./types.js";

export async function runReviewCommentReplyHostRunCommand(
  services: HostRunServices,
  reply: ReviewCommentReplyEvent,
): Promise<HostRunCommandResult> {
  const capabilities = reviewCommentReplyDispatchCapabilities(services);
  if (capabilities.kind === "ignored") {
    return ignore(services.log, capabilities.reason);
  }
  const runnable = runnableReviewCommentReply(reply);
  if (runnable.kind === "ignored") {
    return ignore(services.log, runnable.reason);
  }
  const prepared = await prepareReviewCommentVerifier(services, reply);
  if (prepared.kind === "ignored") {
    return ignore(services.log, prepared.reason);
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
    findingEvents: services.findingLedger.events(),
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
      actorPermission: FindingActorPermission;
    };

async function prepareReviewCommentVerifier(
  services: HostRunServices,
  reply: ReviewCommentReplyEvent,
): Promise<PreparedReviewCommentVerifier> {
  if (!reply.parentCommentId) {
    return { kind: "ignored", reason: "review comment was not a reply" };
  }
  const event = await loadCommentChangeRequest(services, reply);
  const trustedRuntime = await loadTrustedRuntimeForEvent(services, event, services.log);
  const config = trustedRuntime.settings.config;
  if (!config.publication.autoResolve.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve is disabled" };
  }
  if (!config.publication.autoResolve.userReplies.enabled) {
    return { kind: "ignored", reason: "publication.autoResolve.userReplies is disabled" };
  }
  const actorPermission = await allowedVerifierActorPermission(
    services.adapter,
    event,
    reply,
    config,
  );
  if (!actorPermission) {
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
    actorPermission,
  };
}

async function runReviewCommentVerifier(
  services: HostRunServices,
  prepared: Exclude<PreparedReviewCommentVerifier, { kind: "ignored" }>,
) {
  const { event, reply, trustedRuntime } = prepared;
  const config = trustedRuntime.settings.config;
  registerProviderSecrets(config.providers, services.env, services);
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
      ...(reply.threadId ? { threadId: reply.threadId } : {}),
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
    env: services.env,
  });
  await recordArtifactSafely(services, {
    kind: "diff-manifest",
    name: "diff-manifest.json",
    mediaType: "application/json",
    content: JSON.stringify(diffManifest, null, 2),
    sensitive: true,
  });
  const priorReviewState = (
    await services.adapter.comments?.loadPriorReviewState?.({ change: event })
  )?.state;
  const result = await runInternalVerifier({
    workspace: services.rootDir,
    config,
    event,
    provider,
    verifierProvider,
    plan: trustedRuntime.plan,
    env: services.env,
    piProviderModule: services.piProviderModule,
    piStoreDir: changeRequestPiStoreDir(services.piStoreRoot, event),
    piRunner: services.piRunner,
    log: services.log,
    runObserver: services.runObserver,
    diffManifest,
    priorReviewState,
    threadContexts,
    mode: {
      kind: "user-reply",
      reply: {
        commentId: reply.commentId,
        parentCommentId: reply.parentCommentId,
        ...(reply.threadId ? { threadId: reply.threadId } : {}),
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
  services.findingLedger.record(
    findingLedgerContext(
      { event, trustedConfigHash: trustedRuntime.trustedConfigHash },
      runContext,
    ),
    replyOutcomes({
      threadContexts,
      reply,
      actorPermission: prepared.actorPermission,
      verdicts: result.verdicts,
      priorReviewState,
    }),
  );
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

/**
 * The reply's outcome on the replied-to finding, then the verifier's verdicts. Both are anchored
 * to the reply and the markers Pipr leaves, so the next review run rebuilding them from those
 * markers records the same events.
 */
function replyOutcomes(options: {
  threadContexts: readonly InlineThreadContext[];
  reply: ReviewCommentReplyEvent & { parentCommentId: string };
  actorPermission: FindingActorPermission;
  verdicts: Awaited<ReturnType<typeof runInternalVerifier>>["verdicts"];
  priorReviewState: PriorReviewState | undefined;
}): FindingOutcomeEmission[] {
  const records = new Map(options.priorReviewState?.findings.map((record) => [record.id, record]));
  const attribution = (findingId: string) => {
    const stored = priorFindingAttribution(records.get(findingId));
    return stored ? { attribution: stored } : {};
  };
  const thread = replyThreadContext(options.threadContexts, options.reply);
  return [
    ...(thread
      ? [
          {
            kind: "replied" as const,
            findingId: thread.findingId,
            actorPermission: options.actorPermission,
            anchor: findingOutcomeAnchors.reply(replyThreadKey(thread), options.reply.commentId),
            ...attribution(thread.findingId),
          },
        ]
      : []),
    ...options.verdicts.map((verdict) =>
      verifierVerdictOutcome(verdict, priorFindingAttribution(records.get(verdict.findingId))),
    ),
  ];
}

/**
 * The permission that allowed the reply's actor to run the verifier: `unchecked` when any actor
 * is allowed, `author` for the change author, otherwise the host permission; undefined if denied.
 */
async function allowedVerifierActorPermission(
  adapter: CodeHostAdapter,
  event: ChangeRequestEventContext,
  reply: ReviewCommentReplyEvent,
  config: PiprConfig,
): Promise<FindingActorPermission | undefined> {
  const allowed = config.publication.autoResolve.userReplies.allowedActors;
  if (allowed === "any") {
    return "unchecked";
  }
  if (allowed === "author-or-write" && event.change.author?.login === reply.actor) {
    return "author";
  }
  const permission = await adapter.permissions.getRepositoryPermission({
    change: event,
    actor: reply.actor,
  });
  return hasRequiredRepositoryPermission(permission, "write") ? permission : undefined;
}
