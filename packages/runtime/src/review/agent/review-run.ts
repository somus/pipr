import { parseReviewResult } from "@usepipr/sdk";
import { uniqBy } from "lodash-es";
import { match } from "ts-pattern";
import { inputWithDiffManifest } from "../../diff/diff-context.js";
import {
  ProviderExecutionError,
  type ProviderFailureRemediation,
  preferredProviderFailureRemediation,
} from "../../pi/provider-failure.js";
import { runAgentWithProvider } from "./parse-repair.js";
import { assembleReviewAgentRun, scheduledReviewManifests } from "./prompt-assembly.js";
import type { RunReviewAgentOptions, RunReviewAgentResult } from "./review-run-types.js";
import { canonicalInlineFindingsMaxItems } from "./review-schema.js";

export async function runReviewAgent(
  options: RunReviewAgentOptions,
): Promise<RunReviewAgentResult> {
  const maxShards = options.runOptions?.maxShards;
  if (maxShards !== undefined && (!Number.isInteger(maxShards) || maxShards <= 0)) {
    throw new Error("Pi run maxShards must be a positive integer");
  }
  const scheduled = await scheduledReviewManifests(options);
  const totalRuns = scheduled?.manifests.length ?? 1;
  emitReviewWork(options, {
    type: "reviewer-started",
    reviewerOrder: options.runtime.reviewWork?.reviewerOrder ?? 0,
    totalRuns,
  });
  let outcome: "completed" | "failed" = "failed";
  try {
    let result: RunReviewAgentResult;
    if (!scheduled) {
      result = await runReviewAgentUnit(options, 1, totalRuns);
    } else {
      const { manifests } = scheduled;
      if (manifests.length === 1) {
        result = await runReviewAgentUnit(
          {
            ...options,
            input: inputWithDiffManifest(options.input, manifests[0]),
            allowOversizedCondensedManifest: true,
          },
          1,
          totalRuns,
        );
      } else {
        options.runtime.log?.info("diff manifest sharded", {
          agent: options.agent.name ?? "anonymous-agent",
          task: options.runtime.taskName,
          kind: scheduled.kind,
          shardCount: manifests.length,
        });
        const results: RunReviewAgentResult[] = [];
        for (const [index, manifest] of manifests.entries()) {
          results.push(
            await runReviewAgentUnit(
              {
                ...options,
                input: inputWithDiffManifest(options.input, manifest),
                allowOversizedCondensedManifest: true,
                shard: { index: index + 1, count: manifests.length },
              },
              index + 1,
              totalRuns,
            ),
          );
        }
        result = mergeScheduledReviewAgentResults(results, options, scheduled.kind);
      }
    }
    outcome = "completed";
    return result;
  } finally {
    emitReviewWork(options, { type: "reviewer-finished", outcome });
  }
}

async function runReviewAgentUnit(
  options: RunReviewAgentOptions,
  run: number,
  totalRuns: number,
): Promise<RunReviewAgentResult> {
  emitReviewWork(options, { type: "review-run-started", run, totalRuns });
  let outcome: "completed" | "failed" = "failed";
  try {
    const result = await runReviewAgentOnce(options);
    outcome = "completed";
    return result;
  } finally {
    emitReviewWork(options, { type: "review-run-finished", run, totalRuns, outcome });
  }
}

function emitReviewWork(
  options: RunReviewAgentOptions,
  event:
    | { type: "reviewer-started"; reviewerOrder: number; totalRuns: number }
    | { type: "review-run-started"; run: number; totalRuns: number }
    | {
        type: "review-run-finished";
        run: number;
        totalRuns: number;
        outcome: "completed" | "failed";
      }
    | { type: "reviewer-finished"; outcome: "completed" | "failed" },
): void {
  const work = options.runtime.reviewWork;
  if (!work) return;
  const base = {
    taskId: work.taskId,
    reviewerId: work.reviewerId,
    reviewerName: work.reviewerName,
  };
  work.emit({ ...base, ...event });
}

async function runReviewAgentOnce(options: RunReviewAgentOptions): Promise<RunReviewAgentResult> {
  const { prepared, prompt, providers } = await assembleReviewAgentRun(options);
  const scopedOptions = { ...options, ...prepared };
  const errors: string[] = [];
  let remediation: ProviderFailureRemediation | undefined;
  const providerModels: string[] = [];
  let repairAttempted = false;

  for (const [providerIndex, provider] of providers.entries()) {
    providerModels.push(provider.model);
    const attempt = await runAgentWithProvider(
      scopedOptions,
      provider,
      prompt,
      providerIndex === 0 ? "initial" : "fallback",
    );
    repairAttempted ||= attempt.repairAttempted;
    if (attempt.ok) {
      return { value: attempt.value, repairAttempted, providerModels };
    }
    errors.push(`${provider.id}: ${attempt.error}`);
    remediation = preferredProviderFailureRemediation(remediation, attempt.remediation);
  }

  throw new ProviderExecutionError(
    `Pi agent failed for all configured models: ${errors.join("; ")}`,
    remediation,
  );
}

function mergeScheduledReviewAgentResults(
  results: readonly RunReviewAgentResult[],
  options: RunReviewAgentOptions,
  kind: "review" | "inlineFindings",
): RunReviewAgentResult {
  return match(kind)
    .with("inlineFindings", () => {
      const parsed = results.map((result) => options.agent.definition.output.parse(result.value));
      const findings = parsed.flatMap((value) =>
        typeof value === "object" &&
        value !== null &&
        Array.isArray((value as { inlineFindings?: unknown }).inlineFindings)
          ? (value as { inlineFindings: unknown[] }).inlineFindings
          : [],
      );
      const deduplicatedFindings = deduplicateScheduledFindings(findings);
      const maxItems = canonicalInlineFindingsMaxItems(options.agent.definition.output.jsonSchema);
      return {
        value: options.agent.definition.output.parse({
          inlineFindings:
            maxItems === undefined ? deduplicatedFindings : deduplicatedFindings.slice(0, maxItems),
        }),
        repairAttempted: results.some((result) => result.repairAttempted),
        providerModels: results.flatMap((result) => result.providerModels),
      };
    })
    .with("review", () => {
      const reviews = results.map((result) => parseReviewResult(result.value));
      const summaries = [...new Set(reviews.map((review) => review.summary.body))];
      const titles = [...new Set(reviews.flatMap((review) => review.summary.title ?? []))];
      return {
        value: parseReviewResult({
          summary: {
            ...(titles.length === 1 ? { title: titles[0] } : {}),
            body: summaries.join("\n\n"),
          },
          inlineFindings: deduplicateScheduledFindings(
            reviews.flatMap((review) => review.inlineFindings),
          ),
        }),
        repairAttempted: results.some((result) => result.repairAttempted),
        providerModels: results.flatMap((result) => result.providerModels),
      };
    })
    .exhaustive();
}

/** First occurrence wins for findings sharing a path, range, side, line span, and body. */
function deduplicateScheduledFindings<T>(findings: readonly T[]): T[] {
  return uniqBy(findings, (finding) => {
    const field = (name: string): unknown =>
      typeof finding === "object" && finding !== null
        ? (finding as Record<string, unknown>)[name]
        : undefined;
    return JSON.stringify(["path", "rangeId", "side", "startLine", "endLine", "body"].map(field));
  });
}
