import type { PiprRunSummary } from "@usepipr/sdk";
import { summarizeDiffContextCoverage } from "../pi/diff-context-coverage.js";
import { maxReviewStatsModels, sanitizeReviewStatsModel } from "../publication/schemas.js";
import type { ReviewStats } from "../publication/types.js";
import type { PiRunStats } from "./agent/review-run-types.js";

export function accumulateReviewStats(
  prior: ReviewStats | undefined,
  current: ReviewStats | undefined,
): ReviewStats | undefined {
  if (!prior) {
    return current;
  }
  if (!current) {
    const retained = { ...prior };
    delete retained.diffContextCoverage;
    return retained;
  }
  const inputTokens = addUsageTotal(prior.inputTokens, current.inputTokens, Number.isSafeInteger);
  const outputTokens = addUsageTotal(
    prior.outputTokens,
    current.outputTokens,
    Number.isSafeInteger,
  );
  const costUsd = addUsageTotal(prior.costUsd, current.costUsd, Number.isFinite);
  const usageComplete = inputTokens.complete && outputTokens.complete && costUsd.complete;
  const usageStatus =
    usageComplete && prior.usageStatus === current.usageStatus ? prior.usageStatus : "partial";
  const cacheReadTokens = addUsageTotal(
    prior.cacheReadTokens ?? 0,
    current.cacheReadTokens ?? 0,
    Number.isSafeInteger,
  );
  const cacheWriteTokens = addUsageTotal(
    prior.cacheWriteTokens ?? 0,
    current.cacheWriteTokens ?? 0,
    Number.isSafeInteger,
  );
  const cacheUsageComplete = cacheReadTokens.complete && cacheWriteTokens.complete;
  const priorCacheStatus = prior.cacheUsageStatus ?? "unavailable";
  const currentCacheStatus = current.cacheUsageStatus ?? "unavailable";
  const cacheUsageStatus =
    cacheUsageComplete && priorCacheStatus === currentCacheStatus ? priorCacheStatus : "partial";

  return {
    models: [...new Set([...prior.models, ...current.models])].slice(0, maxReviewStatsModels),
    agentRuns: Math.min(Number.MAX_SAFE_INTEGER, prior.agentRuns + current.agentRuns),
    durationMs: Math.min(Number.MAX_SAFE_INTEGER, prior.durationMs + current.durationMs),
    inputTokens: inputTokens.total,
    outputTokens: outputTokens.total,
    costUsd: costUsd.total,
    usageStatus,
    cacheReadTokens: cacheReadTokens.total,
    cacheWriteTokens: cacheWriteTokens.total,
    cacheUsageStatus,
    ...(current.diffContextCoverage ? { diffContextCoverage: current.diffContextCoverage } : {}),
  };
}

/** Adds a usage value, keeping the prior total when the sum is invalid or negative. */
function addUsageTotal(
  prior: number,
  current: number,
  isValid: (value: number) => boolean,
): { total: number; complete: boolean } {
  const total = prior + current;
  return isValid(total) && total >= 0
    ? { total, complete: true }
    : { total: prior, complete: false };
}

export function reviewStatsForRuns(
  runs: PiRunStats[],
  durationMs: number,
): ReviewStats | undefined {
  if (runs.length === 0) {
    return undefined;
  }
  const usage = aggregateReviewUsage(runs);
  const coverage = runs.map((run) => run.diffContextCoverage).filter((item) => item !== undefined);
  return {
    models: collectReviewModels(runs),
    agentRuns: runs.length,
    durationMs,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
    usageStatus: usage.status,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
    cacheUsageStatus: usage.cacheStatus,
    ...(coverage.length > 0 ? { diffContextCoverage: summarizeDiffContextCoverage(coverage) } : {}),
  };
}

export function runSummaryStatsFields(
  stats: ReviewStats | undefined,
): Pick<
  PiprRunSummary,
  | "agentRuns"
  | "inputTokens"
  | "outputTokens"
  | "costUsd"
  | "usageStatus"
  | "cacheReadTokens"
  | "cacheWriteTokens"
  | "cacheUsageStatus"
  | "diffContextCoverage"
> {
  return {
    agentRuns: stats?.agentRuns ?? 0,
    inputTokens: stats?.inputTokens ?? 0,
    outputTokens: stats?.outputTokens ?? 0,
    costUsd: stats?.costUsd ?? 0,
    usageStatus: stats?.usageStatus ?? "unavailable",
    cacheReadTokens: stats?.cacheReadTokens ?? 0,
    cacheWriteTokens: stats?.cacheWriteTokens ?? 0,
    cacheUsageStatus: stats?.cacheUsageStatus ?? "unavailable",
    ...(stats?.diffContextCoverage ? { diffContextCoverage: stats.diffContextCoverage } : {}),
  };
}

function collectReviewModels(runs: PiRunStats[]): string[] {
  const models: string[] = [];
  for (const model of runs.flatMap((run) => run.models)) {
    const sanitized = sanitizeReviewStatsModel(model);
    if (sanitized && models.length < maxReviewStatsModels && !models.includes(sanitized)) {
      models.push(sanitized);
    }
  }
  return models.length > 0 ? models : ["[invalid model]"];
}

function aggregateReviewUsage(runs: PiRunStats[]): {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  status: ReviewStats["usageStatus"];
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cacheStatus: NonNullable<ReviewStats["cacheUsageStatus"]>;
} {
  const core = sumReportedUsage(
    runs.map((run) => run.usage && { values: run.usage, partial: run.usage.status === "partial" }),
    {
      inputTokens: Number.isSafeInteger,
      outputTokens: Number.isSafeInteger,
      costUsd: Number.isFinite,
    },
  );
  const cache = sumReportedUsage(
    runs.map((run) =>
      hasReportedCacheUsage(run)
        ? { values: run.usage, partial: run.usage.cacheUsageStatus === "partial" }
        : undefined,
    ),
    { cacheReadTokens: Number.isSafeInteger, cacheWriteTokens: Number.isSafeInteger },
  );
  return { ...core.totals, status: core.status, ...cache.totals, cacheStatus: cache.status };
}

/** Sums usage fields across runs; runs without a report, partial reports, or overflow make it partial. */
function sumReportedUsage<K extends string>(
  reports: ({ values: Record<NoInfer<K>, number>; partial: boolean } | undefined)[],
  fields: Record<K, (value: number) => boolean>,
): { totals: Record<K, number>; status: "complete" | "partial" | "unavailable" } {
  const keys = Object.keys(fields) as K[];
  const totals = Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
  let reportedRuns = 0;
  let partialUsage = false;
  for (const report of reports) {
    if (!report) continue;
    reportedRuns += 1;
    let complete = true;
    for (const key of keys) {
      const sum = addUsageTotal(totals[key], report.values[key], fields[key]);
      totals[key] = sum.total;
      complete &&= sum.complete;
    }
    partialUsage ||= report.partial || !complete;
  }
  return { totals, status: aggregateUsageStatus(reportedRuns, reports.length, partialUsage) };
}

function hasReportedCacheUsage(run: PiRunStats): run is PiRunStats & {
  usage: PiRunStats["usage"] & {
    cacheReadTokens: number;
    cacheWriteTokens: number;
    cacheUsageStatus: "complete" | "partial";
  };
} {
  return (
    run.usage?.cacheReadTokens !== undefined &&
    run.usage.cacheWriteTokens !== undefined &&
    run.usage.cacheUsageStatus !== undefined &&
    run.usage.cacheUsageStatus !== "unavailable"
  );
}

function aggregateUsageStatus(
  reported: number,
  total: number,
  partial: boolean,
): "complete" | "partial" | "unavailable" {
  if (reported === 0) return "unavailable";
  return reported < total || partial ? "partial" : "complete";
}
