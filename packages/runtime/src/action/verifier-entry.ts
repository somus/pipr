import { buildDiffManifest } from "../diff/diff.js";
import type { CodeHostAdapter, ReviewCommentReplyEvent } from "../hosts/types.js";
import { resolveProvider } from "../review/agent/review-run.js";
import { isPiprThreadActionReplyBody } from "../review/prior-state.js";
import { stableReviewRunId } from "../review/run-identity.js";
import { runInternalVerifier } from "../review/verifier.js";
import type { RuntimeActionLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import { logEventContext, logPhase } from "./action-logging.js";
import { hasRequiredRepositoryPermission } from "./entry-dispatch.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type {
  ActionCommandDependencyOptions,
  ActionCommandResult,
  TrustedRuntimeProject,
} from "./types.js";

export async function runReviewCommentReplyActionCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeActionLog,
  reply: ReviewCommentReplyEvent,
): Promise<ActionCommandResult> {
  const capabilities = reviewCommentReplyDispatchCapabilities(options, adapter);
  if (capabilities.kind === "ignored") {
    log.notice("action ignored", { reason: capabilities.reason });
    return capabilities;
  }
  const runnable = runnableReviewCommentReply(reply);
  if (runnable.kind === "ignored") {
    log.notice("action ignored", { reason: runnable.reason });
    return runnable;
  }
  const prepared = await prepareReviewCommentVerifier(options, adapter, reply, log);
  if (prepared.kind === "ignored") {
    log.notice("action ignored", { reason: prepared.reason });
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
    event: prepared.event,
    configSource: prepared.trustedRuntime.settings.source,
    errors: publication?.errors ?? [],
  };
}

function reviewCommentReplyDispatchCapabilities(
  options: ActionCommandDependencyOptions,
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
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  reply: ReviewCommentReplyEvent,
  log: RuntimeActionLog,
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
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  prepared: Exclude<PreparedReviewCommentVerifier, { kind: "ignored" }>,
  log: RuntimeActionLog,
) {
  const { event, reply, trustedRuntime } = prepared;
  const config = trustedRuntime.settings.config;
  const provider = resolveProvider(config, config.defaultProvider);
  const verifierProvider = resolveProvider(
    config,
    config.publication.autoResolve.model ?? config.defaultProvider,
  );
  const threadContexts =
    (await adapter.comments?.loadInlineThreadContexts?.({ change: event })) ?? [];
  log.notice("verifier start", {
    mode: "user-reply",
    threadContexts: threadContexts.length,
    replyCommentId: reply.commentId,
    parentCommentId: reply.parentCommentId,
  });
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
    diffManifest: buildDiffManifest({
      cwd: options.rootDir,
      baseSha: event.change.base.sha,
      headSha: event.change.head.sha,
    }),
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
    runId: stableReviewRunId({
      event,
      selectedTasks: ["pipr-internal-verifier"],
      trustedConfigSha: trustedRuntime.trustedConfigSha,
      trustedConfigHash: trustedRuntime.trustedConfigHash,
      verifierInvocation: {
        mode: "user-reply",
        commentId: reply.commentId,
        parentCommentId: reply.parentCommentId,
      },
    }),
  });
  return result;
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
    repository: event.repository,
    actor: reply.actor,
  });
  return hasRequiredRepositoryPermission(permission, "write");
}
