import type {
  Agent,
  DiffManifestOptions,
  PiprRunContext,
  SecretRef,
  TaskContext,
} from "@usepipr/sdk";
import { cloneDiffManifest, projectDiffManifest } from "../../diff/manifest-projection.js";
import type { DiffStructuralAnalysisLoader } from "../../diff/structural-analysis.js";
import type { DiffManifest, PiprConfig, ProviderConfig } from "../../types.js";
import type { AgentRunBudget } from "../agent/agent-run-budget.js";
import { runReviewAgent } from "../agent/review-run.js";
import type { PiRunStats } from "../agent/review-run-types.js";
import { validateReviewFindings } from "../review.js";
import {
  collectCommandResponse,
  collectComment,
  createCheckHandle,
  type OutputState,
  priorReviewForTask,
  recordDroppedFindings,
  trackResultFindingScope,
} from "./task-output.js";
import type { TaskRuntimePorts, TaskRuntimeRequest } from "./task-runtime-options.js";

export type CreateTaskContextOptions = TaskRuntimeRequest &
  TaskRuntimePorts & {
    config: PiprConfig;
    provider: ProviderConfig;
    diffManifest: DiffManifest;
    manifestCache: Map<string, DiffManifest>;
    output: OutputState;
    taskName: string;
    taskOrder: number;
    run: PiprRunContext;
    piRunSink: (run: PiRunStats) => void;
    agentRunBudget: AgentRunBudget;
    structuralAnalysis: DiffStructuralAnalysisLoader;
    structuralManifest: () => Promise<DiffManifest>;
  };

export function createTaskContext(options: CreateTaskContextOptions): TaskContext {
  const repositorySlugParts = options.event.repository.slug.split("/");
  let reviewerOrder = 0;
  let taskContext: TaskContext;
  taskContext = {
    run: options.run,
    repository: {
      root: options.workspace,
      owner: repositorySlugParts.length > 1 ? repositorySlugParts[0] : undefined,
      name: repositorySlugParts.at(-1) ?? "repo",
    },
    change: {
      number: options.event.change.number,
      title: options.event.change.title,
      description: options.event.change.description,
      url: options.event.change.url,
      author: options.event.change.author,
      base: options.event.change.base,
      head: options.event.change.head,
      isFork: options.event.change.isFork,
      async diffManifest(manifestOptions?: DiffManifestOptions) {
        const key = JSON.stringify(manifestOptions ?? {});
        const cached = options.manifestCache.get(key);
        if (cached) {
          return cloneDiffManifest(cached);
        }
        const manifest = projectDiffManifest(await options.structuralManifest(), manifestOptions);
        options.manifestCache.set(key, manifest);
        return cloneDiffManifest(manifest);
      },
      async changedFiles() {
        return options.diffManifest.files.map((file) => ({
          path: file.path,
          previousPath: file.previousPath,
          status: file.status,
        }));
      },
    },
    platform: { id: options.event.platform.id },
    command: options.commandInvocation
      ? {
          name: options.commandInvocation.name,
          line: options.commandInvocation.line,
          arguments: { ...options.commandInvocation.arguments },
          async reply(markdown) {
            collectCommandResponse(options.output, markdown, options.taskName);
          },
        }
      : undefined,
    secret(secret) {
      return resolveTaskSecret(secret, options);
    },
    pi: {
      async run(agent, input, runOptions) {
        const resolvedAgent = options.plan.resolveAgent(agent);
        const currentReviewerOrder = reviewerOrder++;
        const reviewerName = resolvedAgent.name?.trim() || `Reviewer ${currentReviewerOrder + 1}`;
        const result = await runReviewAgent({
          agent: resolvedAgent,
          input,
          runOptions,
          runtime: {
            ...options,
            taskContext,
            run: options.run,
            piRunSink: options.piRunSink,
            reviewWork: options.progress
              ? {
                  taskId: String(options.taskOrder),
                  reviewerId: `${options.taskOrder}:${currentReviewerOrder}`,
                  reviewerName,
                  reviewerOrder: currentReviewerOrder,
                  emit: (event) => options.progress?.work(event),
                }
              : undefined,
          },
        });
        options.output.providerModels.push(...result.providerModels);
        if (result.repairAttempted) {
          options.output.repairAttempted = true;
        }
        trackResultFindingScope(options.output, result.value, runOptions?.paths);
        return agentOutputForTaskContext(agent, result.value);
      },
    },
    review: {
      async prior() {
        return priorReviewForTask(options.priorMainComment, options.priorReviewState);
      },
      validateFindings(findings, validationOptions) {
        const paths = validationOptions?.paths ?? options.output.findingScopes.get(findings);
        const validated = validateReviewFindings(findings, options.diffManifest, {
          expectedHeadSha: options.event.change.head.sha,
          pathScopeForFinding: () => paths,
        });
        recordDroppedFindings(options.output, validated.droppedFindings);
        if (paths) {
          options.output.findingScopes.set(validated.validFindings, paths);
        }
        return validated;
      },
    },
    check: createCheckHandle(options.output),
    async comment(value) {
      collectComment(options.output, value, options.taskName);
    },
    log: options.taskLog ?? console,
  };
  return taskContext;
}

function agentOutputForTaskContext<Input, Output>(
  _agent: Agent<Input, Output>,
  value: unknown,
): Output {
  // The agent output schema was parsed by runReviewAgent before TaskContext resolves.
  return value as Output;
}

function resolveTaskSecret(
  secret: SecretRef,
  options: Pick<TaskRuntimePorts, "env" | "log" | "secretRedactor" | "runObserver">,
): string {
  if (secret.kind !== "pipr.secret" || typeof secret.name !== "string") {
    throw new Error("ctx.secret(...) requires a pipr.secret reference");
  }
  const value = (options.env ?? process.env)[secret.name];
  if (!value) {
    throw new Error(`Missing secret env var: ${secret.name}`);
  }
  options.log?.addSecret(value);
  options.secretRedactor?.addSecret(value);
  options.runObserver?.registerSecret?.(value);
  return value;
}
