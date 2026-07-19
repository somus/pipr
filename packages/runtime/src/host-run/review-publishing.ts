import type { RuntimeTask } from "@usepipr/sdk/internal";
import type { CodeHostAdapter } from "../hosts/types.js";
import { publicationPlanForHostCapabilities } from "../review/comment.js";
import { type RuntimeCommandInvocation, runTaskRuntime } from "../review/task/task-runtime.js";
import type { RuntimeLog } from "../shared/logging.js";
import type { ChangeRequestEventContext } from "../types.js";
import {
  finalizeRuntimeChecks,
  genericCheckFailureSummary,
  startRuntimeChecks,
} from "./runtime-checks.js";
import type {
  HostRunCommandDependencyOptions,
  TrustedReviewAndPublishResult,
  TrustedRuntimeProject,
} from "./types.js";

export async function runTrustedReviewAndPublish(options: {
  options: HostRunCommandDependencyOptions;
  adapter: CodeHostAdapter;
  trustedRuntime: TrustedRuntimeProject;
  event: ChangeRequestEventContext;
  taskName?: string;
  taskInput?: unknown;
  selectedTasks: RuntimeTask[];
  commandInvocation?: RuntimeCommandInvocation;
  log: RuntimeLog;
}): Promise<TrustedReviewAndPublishResult> {
  const checks = await startRuntimeChecks({
    adapter: options.adapter,
    event: options.event,
    plan: options.trustedRuntime.plan,
    taskName: options.taskName,
    selectedTasks: options.selectedTasks,
    log: options.log,
  });
  try {
    const review = await runTaskRuntime({
      workspace: options.options.rootDir,
      config: options.trustedRuntime.settings.config,
      event: options.event,
      env: options.options.env,
      plan: options.trustedRuntime.plan,
      versionCompatibility: options.trustedRuntime.versionCompatibility,
      taskName: options.taskName,
      taskInput: options.taskInput,
      commandInvocation: options.commandInvocation,
      trustedConfigSha: options.trustedRuntime.trustedConfigSha,
      trustedConfigHash: options.trustedRuntime.trustedConfigHash,
      piExecutable: options.options.piExecutable,
      log: options.log,
      checkSink: checks?.sink,
      secretRedactor: options.options.secretRedactor,
      loadPriorReviewState: () =>
        options.adapter.comments?.loadPriorReviewState?.({ change: options.event }) ??
        Promise.resolve(undefined),
      loadPriorMainComment: () =>
        options.adapter.comments?.loadPriorMainComment?.({ change: options.event }) ??
        Promise.resolve(undefined),
      loadInlineThreadContexts: () =>
        options.adapter.comments?.loadInlineThreadContexts?.({ change: options.event }) ??
        Promise.resolve([]),
    });
    if (review.kind === "skipped") {
      await finalizeRuntimeChecks(checks, { skipped: true });
      return { kind: "skipped", reason: review.skipReason ?? "review skipped" };
    }
    if (review.kind === "command-response") {
      if (!review.commandResponse) {
        throw new Error("command response result did not include a response body");
      }
      await finalizeRuntimeChecks(checks, {});
      return {
        kind: "command-response",
        run: review.run,
        response: {
          commandName: review.commandResponse.commandName,
          body: review.commandResponse.body,
        },
      };
    }
    const publish = options.adapter.publication?.publish;
    if (!publish) {
      throw new Error("review publication is not available for this code host");
    }
    const publication = await options.log.group("publish review", async () => {
      const publicationPlan = publicationPlanForHostCapabilities(
        review.publicationPlan,
        options.adapter.capabilities,
      );
      options.log.info("publication plan", {
        inlineItems: publicationPlan.inlineItems.length,
        threadActions: publicationPlan.threadActions.length,
      });
      const result = await publish({
        change: options.event,
        plan: publicationPlan,
      });
      options.log.notice("publication result", {
        main: result.mainComment.action,
        inlinePosted: result.inlineComments.posted,
        inlineSkipped: result.inlineComments.skipped,
        inlineFailed: result.inlineComments.failed,
        inlineResolutionErrors: result.metadata.inlineResolutionErrors.length,
      });
      return result;
    });
    await finalizeRuntimeChecks(checks, {});
    return { kind: "completed", review, publication };
  } catch (error) {
    await finalizeRuntimeChecks(checks, {
      forceFailureSummary: genericCheckFailureSummary,
      preserveTaskOutcomes: Array.from(checks?.outcomes.values() ?? []).some(
        (result) => result.conclusion === "failure",
      ),
    }).catch((finalizeError: unknown) => {
      options.log.warning("check finalization after failure failed", {
        error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
      });
    });
    throw error;
  }
}
