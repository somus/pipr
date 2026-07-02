import type { CodeHostAdapter } from "../hosts/types.js";
import type { RuntimeActionLog } from "../shared/logging.js";
import { logEventContext, logPhase } from "./action-logging.js";
import { dispatchRuntimeEntry } from "./entry-dispatch.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type { ActionCommandDependencyOptions, ActionCommandResult } from "./types.js";

export async function runPullRequestActionCommand(
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
