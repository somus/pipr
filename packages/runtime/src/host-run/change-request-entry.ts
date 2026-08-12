import { ReviewProgressSupersededError } from "../review/progress.js";
import type { ChangeRequestEventContext } from "../types.js";
import type { HostRunServices } from "./composition.js";
import { dispatchRuntimeEntry } from "./entry-dispatch.js";
import { logEventContext } from "./logging.js";
import { startReviewProgress } from "./review-progress.js";
import { runTrustedReviewAndPublish } from "./review-publishing.js";
import { loadTrustedRuntimeForEvent, prepareTrustedHeadCheckout } from "./trusted-runtime.js";
import type { HostRunCommandResult, TrustedReviewAndPublishResult } from "./types.js";
import { failureActionFromEnvironment, workflowUrlFromEnvironment } from "./workflow-url.js";

export async function runChangeRequestHostRunCommand(
  services: HostRunServices,
  event: ChangeRequestEventContext,
): Promise<HostRunCommandResult> {
  logEventContext(services.log, event);
  const trustedRuntime = await loadTrustedRuntimeForEvent(services, event, services.log);
  if (services.dryRun) {
    services.log.notice("dry run stop before review runtime, model, or GitHub publishing calls");
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
  services.log.notice("dispatch", {
    selectedTasks: selectedTasks.map((task) => task.name),
  });
  if (selectedTasks.length === 0) {
    services.log.notice("event ignored", { reason: "No tasks matched the change request event" });
    return { kind: "ignored", reason: "No tasks matched the change request event" };
  }
  const workflowUrl = workflowUrlFromEnvironment(services.adapter.id, services.env);
  const progress = await startReviewProgress({
    adapter: services.adapter,
    event,
    config: trustedRuntime.settings.config,
    workflowUrl,
    failureAction: failureActionFromEnvironment(services.adapter.id, services.env),
    log: services.log,
    secretRedactor: services.secretRedactor,
  });
  let completed: TrustedReviewAndPublishResult;
  try {
    await prepareTrustedHeadCheckout(
      services,
      services.adapter,
      trustedRuntime.settings.config,
      event,
      services.log,
    );
    completed = await runTrustedReviewAndPublish({
      services,
      trustedRuntime,
      event,
      selectedTasks,
      workflowUrl,
      progress,
    });
  } catch (error) {
    const progressFailure = await progress?.fail(error);
    if (error instanceof ReviewProgressSupersededError) throw error;
    if (progressFailure === "superseded") throw new ReviewProgressSupersededError();
    throw error;
  }
  if (completed.kind === "skipped") {
    services.log.notice("event ignored", { reason: completed.reason });
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
