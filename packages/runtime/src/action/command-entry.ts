import { firstNonEmptyLine, isPiprCommandLine } from "../commands/grammar.js";
import type { CodeHostAdapter, CommandCommentEvent } from "../hosts/types.js";
import type { RuntimeActionLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";
import { parseChangeRequestEventContext } from "../types.js";
import { logEventContext, logPhase } from "./action-logging.js";
import {
  dispatchRuntimeEntry,
  hasRequiredRepositoryPermission,
  type PlanCommandResolution,
  parsePlanCommandInputs,
  permissionDeniedHelp,
  resolvePlanCommand,
} from "./entry-dispatch.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type {
  ActionCommandDependencyOptions,
  ActionCommandResult,
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

export async function runIssueCommentActionCommand(
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
