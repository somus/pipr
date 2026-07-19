import { firstNonEmptyLine, isPiprCommandLine } from "../commands/grammar.js";
import type {
  CodeHostAdapter,
  CodeHostPublication,
  CommandCommentEvent,
  CommandLifecycleState,
} from "../hosts/types.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import {
  dispatchRuntimeEntry,
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "./entry-dispatch.js";
import { logEventContext, logPhase } from "./logging.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type {
  HostRunCommandDependencyOptions,
  HostRunCommandResult,
  TrustedReviewAndPublishResult,
  TrustedRuntimeProject,
} from "./types.js";

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

type ParsedCommandInvocation = Extract<
  ReturnType<typeof parsePlanCommandInputs>,
  { kind: "matched" }
>["invocation"];

type CommandStatusTarget = {
  change: ChangeRequestEventContext;
  sourceCommentId: string;
  commandName: string;
  reviewedHeadSha: string;
};

export async function runIssueCommentHostRunCommand(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeLog,
  comment: CommandCommentEvent,
): Promise<HostRunCommandResult> {
  if (!adapter.capabilities.commandComments) {
    const ignored = { kind: "ignored" as const, reason: "host adapter does not support commands" };
    log.notice("event ignored", { reason: ignored.reason });
    return ignored;
  }
  const prepared = await prepareIssueCommentCommand(options, adapter, log, comment);
  if (prepared.kind === "ignored") {
    log.notice("event ignored", { reason: prepared.reason });
    return prepared;
  }
  return await dispatchIssueCommentCommand(options, adapter, prepared, log);
}

async function prepareIssueCommentCommand(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeLog,
  comment: CommandCommentEvent,
): Promise<PreparedIssueCommentCommand> {
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
    coordinates: loaded.coordinates,
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
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  prepared: Extract<PreparedIssueCommentCommand, { kind: "prepared" }>,
  log: RuntimeLog,
): Promise<HostRunCommandResult> {
  const requiredPermission =
    prepared.resolution.kind === "matched"
      ? prepared.resolution.invocation.requiredPermission
      : prepared.resolution.requiredPermission;
  const permission = await logPhase(log, "check command permission", async () =>
    adapter.permissions.getRepositoryPermission({
      change: prepared.event,
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

  const publishCommandStatus = requiredCommandStatusPublisher(adapter);
  const status = {
    change: prepared.event,
    sourceCommentId: prepared.comment.commentId,
    commandName: parsedResolution.invocation.commandName,
    reviewedHeadSha: prepared.event.change.head.sha,
  };
  await logPhase(log, "publish command accepted", async () =>
    publishCommandStatus({ ...status, state: "accepted" }),
  );

  return await executeIssueCommentCommand({
    options,
    adapter,
    prepared,
    invocation: parsedResolution.invocation,
    publishCommandStatus,
    status,
    log,
  });
}

async function executeIssueCommentCommand(options: {
  options: HostRunCommandDependencyOptions;
  adapter: CodeHostAdapter;
  prepared: Extract<PreparedIssueCommentCommand, { kind: "prepared" }>;
  invocation: ParsedCommandInvocation;
  publishCommandStatus: NonNullable<CodeHostPublication["publishCommandStatus"]>;
  status: CommandStatusTarget;
  log: RuntimeLog;
}): Promise<HostRunCommandResult> {
  try {
    await prepareTrustedHeadCheckout(
      options.options,
      options.adapter,
      options.prepared.trustedRuntime.settings.config,
      options.prepared.event,
      options.log,
    );
    const dispatch = dispatchRuntimeEntry({
      kind: "change-request",
      plan: options.prepared.trustedRuntime.plan,
      event: options.prepared.event,
      taskName: options.invocation.taskName,
    });
    await logPhase(options.log, "publish command running", async () =>
      options.publishCommandStatus({ ...options.status, state: "running" }),
    );
    const completed = await runTrustedReviewAndPublish({
      options: options.options,
      adapter: options.adapter,
      trustedRuntime: options.prepared.trustedRuntime,
      event: options.prepared.event,
      taskName: options.invocation.taskName,
      taskInput: options.invocation.inputs,
      selectedTasks: dispatch.kind === "change-request" ? dispatch.tasks : [],
      commandInvocation: {
        name: options.invocation.commandName,
        line: options.invocation.line,
        arguments: options.invocation.arguments,
        sourceCommentId: options.prepared.comment.commentId,
      },
      log: options.log,
    });
    const result = await issueCommentCommandResult({
      adapter: options.adapter,
      completed,
      event: options.prepared.event,
      commandName: options.invocation.commandName,
      sourceCommentId: options.prepared.comment.commentId,
      configSource: options.prepared.trustedRuntime.settings.source,
    });
    if (completed.kind !== "command-response") {
      await logPhase(options.log, "publish command completed", async () =>
        options.publishCommandStatus({ ...options.status, state: "completed" }),
      );
    }
    return result;
  } catch (error) {
    await publishFailedCommandStatus({
      adapter: options.adapter,
      comment: options.prepared.comment,
      event: options.prepared.event,
      publishCommandStatus: options.publishCommandStatus,
      status: options.status,
      log: options.log,
    });
    throw error;
  }
}

function requiredCommandStatusPublisher(
  adapter: CodeHostAdapter,
): NonNullable<CodeHostPublication["publishCommandStatus"]> {
  const publishCommandStatus = adapter.publication?.publishCommandStatus;
  if (!publishCommandStatus) {
    throw new Error("command status publication is not available for this code host");
  }
  return publishCommandStatus;
}

async function publishFailedCommandStatus(options: {
  adapter: CodeHostAdapter;
  comment: CommandCommentEvent;
  event: ChangeRequestEventContext;
  publishCommandStatus: NonNullable<CodeHostPublication["publishCommandStatus"]>;
  status: CommandStatusTarget;
  log: RuntimeLog;
}): Promise<void> {
  let state: Extract<CommandLifecycleState, "failed" | "superseded"> = "failed";
  let currentHeadSha: string | undefined;
  try {
    const current = await options.adapter.events.loadChangeRequest({
      repository: options.comment.repository,
      changeNumber: options.comment.changeNumber,
      workspace: options.comment.workspace,
      eventName: options.comment.eventName,
      action: options.comment.action,
      rawAction: options.comment.rawAction,
    });
    currentHeadSha = current.change.head.sha;
    if (currentHeadSha !== options.event.change.head.sha) {
      state = "superseded";
    }
  } catch (reloadError) {
    options.log.warning("command failure head reload failed", {
      error: reloadError instanceof Error ? reloadError.message : String(reloadError),
    });
  }
  try {
    await options.publishCommandStatus({
      ...options.status,
      state,
      ...(currentHeadSha ? { currentHeadSha } : {}),
    });
  } catch (statusError) {
    options.log.warning("command terminal status publication failed", {
      error: statusError instanceof Error ? statusError.message : String(statusError),
    });
  }
}

async function issueCommentCommandResult(options: {
  adapter: CodeHostAdapter;
  completed: TrustedReviewAndPublishResult;
  event: ChangeRequestEventContext;
  commandName: string;
  sourceCommentId: string;
  configSource: string;
}): Promise<HostRunCommandResult> {
  if (options.completed.kind === "skipped") {
    return { kind: "ignored", reason: options.completed.reason };
  }
  if (options.completed.kind === "command-response") {
    return await publishCommandResponseHostRunResult({
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

async function publishCommandResponseHostRunResult(options: {
  adapter: CodeHostAdapter;
  completed: Extract<TrustedReviewAndPublishResult, { kind: "command-response" }>;
  event: ChangeRequestEventContext;
  sourceCommentId: string;
  configSource: string;
}): Promise<HostRunCommandResult> {
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
    run: options.completed.run,
    configSource: options.configSource,
    response: { body: options.completed.response.body },
    publication,
  };
}
