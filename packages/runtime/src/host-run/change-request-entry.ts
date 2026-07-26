import type { CodeHostAdapter } from "../hosts/types.js";
import { ReviewProgressSupersededError } from "../review/progress.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";
import { dispatchRuntimeEntry } from "./entry-dispatch.js";
import { logEventContext } from "./logging.js";
import { startReviewProgress } from "./review-progress.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type {
  HostRunCommandDependencyOptions,
  HostRunCommandResult,
  TrustedReviewAndPublishResult,
} from "./types.js";
import { workflowUrlFromEnvironment } from "./workflow-url.js";

export async function runChangeRequestHostRunCommand(
  options: HostRunCommandDependencyOptions,
  adapter: CodeHostAdapter,
  log: RuntimeLog,
  event: ChangeRequestEventContext,
): Promise<HostRunCommandResult> {
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
  const dispatch = dispatchRuntimeEntry({
    kind: "change-request",
    plan: trustedRuntime.plan,
    event,
  });
  const selectedTasks = dispatch.kind === "change-request" ? dispatch.tasks : [];
  log.notice("dispatch", {
    selectedTasks: selectedTasks.map((task) => task.name),
  });
  if (selectedTasks.length === 0) {
    log.notice("event ignored", { reason: "No tasks matched the change request event" });
    return { kind: "ignored", reason: "No tasks matched the change request event" };
  }
  const workflowUrl = workflowUrlFromEnvironment(adapter.id, options.env ?? process.env);
  const progress = await startReviewProgress({
    adapter,
    event,
    config: trustedRuntime.settings.config,
    workflowUrl,
    log,
    secretRedactor: options.secretRedactor,
  });
  let completed: TrustedReviewAndPublishResult;
  try {
    await prepareTrustedHeadCheckout(options, adapter, trustedRuntime.settings.config, event, log);
    completed = await runTrustedReviewAndPublish({
      options,
      adapter,
      trustedRuntime,
      event,
      selectedTasks,
      workflowUrl,
      progress,
      log,
    });
  } catch (error) {
    await progress?.fail(error);
    if (error instanceof ReviewProgressSupersededError) {
      return { kind: "ignored", reason: error.message };
    }
    throw error;
  }
  if (completed.kind === "skipped") {
    log.notice("event ignored", { reason: completed.reason });
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
