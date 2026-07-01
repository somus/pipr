import { firstNonEmptyLine, isPiprCommandLine } from "../commands/grammar.js";
import {
  type InitOfficialMinimalProjectResult,
  initOfficialMinimalProject,
} from "../config/init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../config/project.js";
import { buildDiffManifest } from "../diff/diff.js";
import { runGit as runGitCommand } from "../diff/git.js";
import { createLocalChangeRequestEvent } from "../hosts/local/adapter.js";
import type {
  CodeHostAdapter,
  CommandCommentEvent,
  ReviewCommentReplyEvent,
} from "../hosts/types.js";
import { resolveProvider } from "../review/agent/review-run.js";
import { isPiprThreadActionReplyBody } from "../review/prior-state.js";
import { runTaskRuntime } from "../review/task/task-runtime.js";
import { runInternalVerifier } from "../review/verifier.js";
import { createRuntimeActionLog, type RuntimeActionLog } from "../shared/logging.js";
import type { ChangeRequestEventContext, PiprConfig } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import { assertTrustedActionProviderEnv, createActionHostAdapter } from "./action-host.js";
import {
  addProviderSecrets,
  logEventContext,
  logPhase,
  logTrustedRuntime,
} from "./action-logging.js";
import {
  dispatchRuntimeEntry,
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
  selectLocalReviewTasks,
} from "./entry-dispatch.js";
import { loadRuntimeProjectFromGitCommit } from "./git-project.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
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
  TrustedReviewAndPublishResult,
  TrustedRuntimeProject,
  ValidateCommandResult,
} from "./types.js";

export type { ActionLogSink } from "../shared/logging.js";
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

async function runPullRequestActionCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeActionLog,
): Promise<ActionCommandResult> {
  const event = await logPhase(log, "parse event", async () =>
    adapter.events.parseEvent({
      eventPath: options.eventPath,
      env: options.env ?? process.env,
      workspace: options.rootDir,
    }),
  );
  logEventContext(log, event);
  const trustedRuntime = await loadTrustedRuntimeForEvent(options, event, log);
  if (options.dryRun) {
    log.notice("dry run stop before review runtime, model, or GitHub publishing calls");
    return {
      kind: "dry-run",
      event,
      configSource: trustedRuntime.settings.source,
    };
  }
  await prepareTrustedHeadCheckout(options, adapter, trustedRuntime.settings.config, event, log);
  const dispatch = dispatchRuntimeEntry({
    kind: "change-request",
    plan: trustedRuntime.plan,
    event,
  });
  const selectedTasks = dispatch.kind === "change-request" ? dispatch.tasks : [];
  log.notice("dispatch", {
    selectedTasks: selectedTasks.map((task) => task.name),
  });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime,
    event,
    selectedTasks,
    log,
  });
  if (completed.kind === "skipped") {
    log.notice("action ignored", { reason: completed.reason });
    return { kind: "ignored", reason: completed.reason };
  }
  if (completed.kind === "command-response") {
    throw new Error("command response result is only supported for issue_comment commands");
  }
  return {
    kind: "review",
    event,
    configSource: trustedRuntime.settings.source,
    review: completed.review,
    publication: completed.publication,
  };
}

async function loadTrustedRuntimeForEvent(
  options: ActionCommandDependencyOptions,
  event: ChangeRequestEventContext,
  log: RuntimeActionLog,
): Promise<TrustedRuntimeProject> {
  const trustedRuntime = await logPhase(log, "load trusted config", async () =>
    loadRuntimeProjectFromGitCommit({
      rootDir: options.rootDir,
      configDir: options.configDir,
      commitSha: event.change.base.sha,
      env: options.env,
    }),
  );
  logTrustedRuntime(log, trustedRuntime);
  return trustedRuntime;
}

async function prepareTrustedHeadCheckout(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  config: PiprConfig,
  event: ChangeRequestEventContext,
  log: RuntimeActionLog,
): Promise<void> {
  addProviderSecrets(log, config, options.env);
  assertTrustedActionProviderEnv(options, config);
  await logPhase(log, "checkout head", async () => {
    adapter.workspace.ensureHeadCheckout({ rootDir: options.rootDir, change: event });
  });
}

async function runIssueCommentActionCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeActionLog,
): Promise<ActionCommandResult> {
  const prepared = await prepareIssueCommentCommand(options, adapter, log);
  if (prepared.kind === "ignored") {
    log.notice("action ignored", { reason: prepared.reason });
    return prepared;
  }
  return await dispatchIssueCommentCommand(options, adapter, prepared, log);
}

async function runReviewCommentReplyActionCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeActionLog,
): Promise<ActionCommandResult> {
  const capabilities = reviewCommentReplyDispatchCapabilities(options, adapter);
  if (capabilities.kind === "ignored") {
    log.notice("action ignored", { reason: capabilities.reason });
    return capabilities;
  }
  const reply = await logPhase(log, "parse review comment reply", async () =>
    capabilities.resolveReviewCommentReply({
      eventPath: options.eventPath,
      env: options.env ?? process.env,
      workspace: options.rootDir,
    }),
  );
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
      resolveReviewCommentReply: NonNullable<
        CodeHostAdapter["events"]["resolveReviewCommentReply"]
      >;
      publishThreadActions: NonNullable<
        NonNullable<CodeHostAdapter["publication"]>["publishThreadActions"]
      >;
    } {
  if (!adapter.events.resolveReviewCommentReply) {
    return { kind: "ignored", reason: "host adapter does not support review comment replies" };
  }
  if (!adapter.publication?.publishThreadActions) {
    return { kind: "ignored", reason: "host adapter does not support verifier thread actions" };
  }
  if (options.dryRun) {
    return { kind: "ignored", reason: "PIPR_DRY_RUN=1; verifier dispatch skipped" };
  }
  return {
    kind: "ready",
    resolveReviewCommentReply: adapter.events.resolveReviewCommentReply,
    publishThreadActions: adapter.publication.publishThreadActions,
  };
}

type PreparedReviewCommentVerifier =
  | { kind: "ignored"; reason: string }
  | {
      kind: "prepared";
      reply: ReviewCommentReplyEvent & { parentCommentId: number };
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

type PreparedIssueCommentCommand =
  | { kind: "ignored"; reason: string }
  | {
      kind: "prepared";
      comment: CommandCommentEvent;
      line: string;
      event: ChangeRequestEventContext;
      trustedRuntime: TrustedRuntimeProject;
      resolution: Exclude<PlanCommandResolution, { kind: "ignored" }>;
    };

async function prepareIssueCommentCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeActionLog,
): Promise<PreparedIssueCommentCommand> {
  const comment = await logPhase(log, "parse issue comment", async () =>
    adapter.events.resolveCommandComment({
      eventPath: options.eventPath,
      env: options.env ?? process.env,
      workspace: options.rootDir,
    }),
  );
  const runnable = runnableIssueCommentCommand(comment, options.dryRun);
  if (runnable.kind === "ignored") {
    return runnable;
  }
  const loaded = await logPhase(log, "load change request", async () =>
    adapter.events.loadChangeRequest({
      repository: comment.repository,
      changeNumber: comment.changeNumber,
      workspace: comment.workspace,
      eventName: comment.eventName,
      action: comment.action,
      rawAction: comment.rawAction,
    }),
  );
  const event = parseChangeRequestEventContext({
    eventName: loaded.eventName ?? comment.eventName,
    action: loaded.action ?? comment.action,
    rawAction: loaded.rawAction ?? comment.rawAction,
    platform: { id: adapter.id },
    repository: loaded.repository,
    change: loaded.change,
    workspace: loaded.workspace ?? comment.workspace,
  });
  logEventContext(log, event);
  const trustedRuntime = await loadTrustedRuntimeForEvent(options, event, log);
  const resolution = resolvePlanCommand(trustedRuntime.plan, runnable.line);
  if (resolution.kind === "ignored") {
    return { kind: "ignored", reason: resolution.reason };
  }
  return { kind: "prepared", comment, line: runnable.line, event, trustedRuntime, resolution };
}

function runnableIssueCommentCommand(
  comment: CommandCommentEvent,
  dryRun: boolean,
): { kind: "runnable"; line: string } | { kind: "ignored"; reason: string } {
  if (!comment.isChangeRequest) {
    return { kind: "ignored", reason: "issue_comment did not target a pull request" };
  }
  if (comment.action !== "created") {
    return { kind: "ignored", reason: `issue_comment action '${comment.action}' is not supported` };
  }
  const line = firstNonEmptyLine(comment.body);
  if (!line || !isPiprCommandLine(line)) {
    return { kind: "ignored", reason: "issue_comment did not target pipr" };
  }
  return dryRun
    ? { kind: "ignored", reason: "PIPR_DRY_RUN=1; command dispatch skipped" }
    : { kind: "runnable", line };
}

async function dispatchIssueCommentCommand(
  options: ActionCommandDependencyOptions,
  adapter: CodeHostAdapter,
  prepared: Extract<PreparedIssueCommentCommand, { kind: "prepared" }>,
  log: RuntimeActionLog,
): Promise<ActionCommandResult> {
  const requiredPermission =
    prepared.resolution.kind === "matched"
      ? prepared.resolution.invocation.requiredPermission
      : prepared.resolution.requiredPermission;
  const permission = await logPhase(log, "check command permission", async () =>
    adapter.permissions.getRepositoryPermission({
      repository: prepared.comment.repository,
      actor: prepared.comment.actor,
    }),
  );
  log.notice("command dispatch", {
    resolution: prepared.resolution.kind,
    requiredPermission,
    actualPermission: permission,
  });
  if (!hasRequiredRepositoryPermission(permission, requiredPermission)) {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.settings.source,
      body: permissionDeniedHelp(prepared.trustedRuntime.plan, requiredPermission),
      reason: `permission denied for '${prepared.line}'`,
    };
  }
  if (prepared.resolution.kind === "help" || prepared.resolution.kind === "invalid") {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.settings.source,
      body: prepared.resolution.body,
      reason: prepared.resolution.reason,
    };
  }

  const parsedResolution = parsePlanCommandInputs(
    prepared.trustedRuntime.plan,
    prepared.resolution.invocation,
  );
  if (parsedResolution.kind === "invalid") {
    return {
      kind: "command-help",
      event: prepared.event,
      configSource: prepared.trustedRuntime.settings.source,
      body: parsedResolution.body,
      reason: parsedResolution.reason,
    };
  }
  if (parsedResolution.kind !== "matched") {
    return { kind: "ignored", reason: "command dispatch did not resolve to a runnable task" };
  }

  await prepareTrustedHeadCheckout(
    options,
    adapter,
    prepared.trustedRuntime.settings.config,
    prepared.event,
    log,
  );
  const dispatch = dispatchRuntimeEntry({
    kind: "change-request",
    plan: prepared.trustedRuntime.plan,
    event: prepared.event,
    taskName: parsedResolution.invocation.taskName,
  });
  const completed = await runTrustedReviewAndPublish({
    options,
    adapter,
    trustedRuntime: prepared.trustedRuntime,
    event: prepared.event,
    taskName: parsedResolution.invocation.taskName,
    taskInput: parsedResolution.invocation.inputs,
    selectedTasks: dispatch.kind === "change-request" ? dispatch.tasks : [],
    commandInvocation: {
      name: parsedResolution.invocation.commandName,
      line: parsedResolution.invocation.line,
      arguments: parsedResolution.invocation.arguments,
    },
    log,
  });
  return await issueCommentCommandResult({
    adapter,
    completed,
    event: prepared.event,
    commandName: parsedResolution.invocation.commandName,
    sourceCommentId: prepared.comment.commentId,
    configSource: prepared.trustedRuntime.settings.source,
  });
}

async function issueCommentCommandResult(options: {
  adapter: CodeHostAdapter;
  completed: TrustedReviewAndPublishResult;
  event: ChangeRequestEventContext;
  commandName: string;
  sourceCommentId: number;
  configSource: string;
}): Promise<ActionCommandResult> {
  if (options.completed.kind === "skipped") {
    return { kind: "ignored", reason: options.completed.reason };
  }
  if (options.completed.kind === "command-response") {
    return await publishCommandResponseActionResult({
      adapter: options.adapter,
      completed: options.completed,
      event: options.event,
      sourceCommentId: options.sourceCommentId,
      configSource: options.configSource,
    });
  }
  return {
    kind: "review",
    event: options.event,
    command: options.commandName,
    configSource: options.configSource,
    review: options.completed.review,
    publication: options.completed.publication,
  };
}

async function publishCommandResponseActionResult(options: {
  adapter: CodeHostAdapter;
  completed: Extract<TrustedReviewAndPublishResult, { kind: "command-response" }>;
  event: ChangeRequestEventContext;
  sourceCommentId: number;
  configSource: string;
}): Promise<ActionCommandResult> {
  const publishCommandResponse = options.adapter.publication?.publishCommandResponse;
  if (!publishCommandResponse) {
    throw new Error("command response publication is not available for this code host");
  }
  const publication = await publishCommandResponse({
    change: options.event,
    sourceCommentId: options.sourceCommentId,
    commandName: options.completed.response.commandName,
    body: options.completed.response.body,
  });
  return {
    kind: "command-response",
    event: options.event,
    command: options.completed.response.commandName,
    configSource: options.configSource,
    response: { body: options.completed.response.body },
    publication,
  };
}
