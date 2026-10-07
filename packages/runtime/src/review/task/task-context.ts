import type {
  Agent,
  CommentValue,
  DiffManifestOptions,
  PathFilter,
  PiprRunContext,
  ReviewFinding,
  SecretRef,
  SelectedReviewFindings,
  SelectFindingsOptions,
  TaskContext,
} from "@usepipr/sdk";
import { facetsForFindingSchema, isMarkdownText, markdownString } from "@usepipr/sdk/internal";
import { createDiffContext } from "../../diff/diff-context.js";
import { cloneDiffManifest, projectDiffManifest } from "../../diff/manifest-projection.js";
import type { DiffStructuralAnalysisLoader } from "../../diff/structural-analysis.js";
import type { PiRunner } from "../../pi/types.js";
import type { DiffManifest, PiprConfig, ProviderConfig } from "../../types.js";
import { type AgentRunBudget, assertAgentRunCapacity } from "../agent/agent-run-budget.js";
import { runReviewAgent } from "../agent/review-run.js";
import type { PiRunStats } from "../agent/review-run-types.js";
import { validateReviewFindings } from "../review.js";
import { capDropReason, selectRankedFindings } from "../selection.js";
import { isPublishableSuggestedFixSelection } from "../suggested-fix-publication-policy.js";
import {
  collectCommandResponse,
  collectComment,
  createCheckHandle,
  type OutputState,
  priorReviewForTask,
  type RuntimeCommentValue,
  recordDroppedFindings,
  recordFindingFacets,
  trackResultFindingScope,
} from "./task-output.js";
import type { TaskRuntimePorts, TaskRuntimeRequest } from "./task-runtime-options.js";

export type CreateTaskContextOptions = TaskRuntimeRequest &
  TaskRuntimePorts & {
    config: PiprConfig;
    provider: ProviderConfig;
    piRunner: PiRunner;
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
  const runAgent = async (
    agent: Agent<unknown, unknown>,
    input: unknown,
    runOptions: Parameters<TaskContext["pi"]["run"]>[2],
    forkSharedContext: boolean,
  ): Promise<unknown> => {
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
        forkSharedContext,
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
  };
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
      async diff(manifestOptions?: DiffManifestOptions) {
        const key = JSON.stringify(manifestOptions ?? {});
        const cached = options.manifestCache.get(key);
        if (cached) {
          return createDiffContext(cloneDiffManifest(cached));
        }
        const manifest = projectDiffManifest(await options.structuralManifest(), manifestOptions);
        options.manifestCache.set(key, manifest);
        return createDiffContext(cloneDiffManifest(manifest));
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
            collectCommandResponse(options.output, markdownString(markdown), options.taskName);
          },
        }
      : undefined,
    secret(secret) {
      return resolveTaskSecret(secret, options);
    },
    pi: {
      async run(agent, input, runOptions) {
        return (await runAgent(
          agent as Agent<unknown, unknown>,
          input,
          runOptions,
          false,
        )) as never;
      },
      async all(runs) {
        assertAgentRunCapacity(options.agentRunBudget, runs.length);
        return (await Promise.all(
          runs.map((request) =>
            runAgent(
              request.agent as Agent<unknown, unknown>,
              request.input,
              request.options,
              runs.length > 1,
            ),
          ),
        )) as never;
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
      select<T extends ReviewFinding>(
        findings: readonly T[] | readonly (readonly T[])[],
        selectOptions: SelectFindingsOptions<T> = {},
      ): SelectedReviewFindings<T> {
        const lists = isFindingLists(findings) ? findings : [findings];
        const scopes = findingScopesByFinding(options.output, lists, selectOptions.paths);
        const facets = facetsForFindingSchema(selectOptions.finding) ?? {};
        const ranked = selectRankedFindings<T>(lists.flat(), {
          facets,
          rank: selectOptions.rank,
          compare: selectOptions.compare as ((left: T, right: T) => number) | undefined,
        }).findings;
        const validated = validateReviewFindings<T>(ranked, options.diffManifest, {
          expectedHeadSha: options.event.change.head.sha,
          pathScopeForFinding: (_finding, index) => scopes.get(ranked[index] as T),
        });
        const capped = capSelectedFindings(validated.validFindings, {
          manifest: options.diffManifest,
          requireSuggestedFix: selectOptions.requireSuggestedFix === true,
          limit: selectOptions.limit ?? options.config.publication.maxInlineComments,
        });
        const selected = capped.findings;
        const dropped = [...validated.droppedFindings, ...capped.dropped];
        recordDroppedFindings(options.output, dropped);
        recordFindingFacets(options.output, selected, facets);
        const paths = selectOptions.paths ?? sharedFindingScope(options.output, lists);
        if (paths) {
          options.output.findingScopes.set(selected, paths);
        }
        return { findings: selected, dropped };
      },
    },
    check: createCheckHandle(options.output),
    async comment(value) {
      collectComment(options.output, normalizeCommentValue(value), options.taskName);
    },
    log: options.taskLog ?? console,
  };
  return taskContext;
}

function isFindingLists<T>(
  value: readonly T[] | readonly (readonly T[])[],
): value is readonly (readonly T[])[] {
  return value.length > 0 && value.every(Array.isArray);
}

function findingScopesByFinding<T extends ReviewFinding>(
  output: OutputState,
  lists: readonly (readonly T[])[],
  paths: PathFilter | undefined,
): Map<T, PathFilter | undefined> {
  const scopes = new Map<T, PathFilter | undefined>();
  for (const list of lists) {
    const scope = paths ?? output.findingScopes.get(list);
    for (const finding of list) {
      scopes.set(finding, scope);
    }
  }
  return scopes;
}

function capSelectedFindings<F extends ReviewFinding>(
  findings: readonly F[],
  options: { manifest: DiffManifest; requireSuggestedFix: boolean; limit: number | undefined },
): { findings: F[]; dropped: { finding: F; reason: string }[] } {
  const unfixable = options.requireSuggestedFix
    ? findings.filter((finding) => !hasPublishableSuggestedFix(finding, options.manifest))
    : [];
  const candidates = findings.filter((finding) => !unfixable.includes(finding));
  return {
    findings: candidates.slice(0, options.limit),
    dropped: [
      ...unfixable.map((finding) => ({ finding, reason: unpublishableSuggestedFixDropReason })),
      ...candidates.slice(options.limit).map((finding) => ({ finding, reason: capDropReason })),
    ],
  };
}

const unpublishableSuggestedFixDropReason = "suggested fix is missing or not publishable";

function hasPublishableSuggestedFix(finding: ReviewFinding, manifest: DiffManifest): boolean {
  if (!finding.suggestedFix) {
    return false;
  }
  const range = manifest.files
    .flatMap((file) => file.commentableRanges)
    .find((candidate) => candidate.id === finding.rangeId);
  return (
    range !== undefined &&
    isPublishableSuggestedFixSelection({
      side: range.side,
      kind: range.kind,
      rangeStartLine: range.startLine,
      startLine: finding.startLine,
      endLine: finding.endLine,
      preview: range.preview,
      suggestedFix: finding.suggestedFix,
    })
  );
}

function sharedFindingScope(
  output: OutputState,
  lists: readonly (readonly ReviewFinding[])[],
): PathFilter | undefined {
  const scopes = new Set(lists.map((list) => output.findingScopes.get(list)));
  return scopes.size === 1 ? [...scopes][0] : undefined;
}

function normalizeCommentValue(value: CommentValue): RuntimeCommentValue {
  if (typeof value === "string" || isMarkdownText(value)) {
    return markdownString(value);
  }
  return value.main === undefined ? value : { ...value, main: markdownString(value.main) };
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
