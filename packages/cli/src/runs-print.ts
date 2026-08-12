import type { diagnoseRunBundle, RunRecord } from "@usepipr/runtime";

const runListColumnWidths = {
  executionId: 32,
  kind: 9,
  outcome: 12,
  state: 21,
  protection: 10,
  startedAt: 25,
} as const;

export function printRunList(runs: RunRecord[]): void {
  if (runs.length === 0) {
    console.log("No Pipr runs found.");
    return;
  }
  console.log(
    [
      formatRunListColumn("EXECUTION ID", runListColumnWidths.executionId),
      formatRunListColumn("KIND", runListColumnWidths.kind),
      formatRunListColumn("OUTCOME", runListColumnWidths.outcome),
      formatRunListColumn("STATE", runListColumnWidths.state),
      formatRunListColumn("PROTECTION", runListColumnWidths.protection),
      formatRunListColumn("STARTED", runListColumnWidths.startedAt),
      "LOCATION",
    ].join("  "),
  );
  for (const run of runs) {
    console.log(
      [
        formatRunListColumn(run.executionId, runListColumnWidths.executionId),
        formatRunListColumn(run.kind ?? "unknown", runListColumnWidths.kind),
        formatRunListColumn(run.outcome ?? "unknown", runListColumnWidths.outcome),
        formatRunListColumn(run.state, runListColumnWidths.state),
        formatRunListColumn(run.protection ?? "unknown", runListColumnWidths.protection),
        formatRunListColumn(run.startedAt ?? "unknown", runListColumnWidths.startedAt),
        run.nativeUrl ?? run.error ?? "-",
      ].join("  "),
    );
  }
}

function formatRunListColumn(value: string, width: number): string {
  return value.slice(0, width).padEnd(width);
}

export function printDiagnosis(
  manifest: Awaited<
    ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>
  >["manifest"],
  diagnosis: ReturnType<typeof diagnoseRunBundle>,
  timeline?: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>["spans"],
): void {
  printRunOverview(manifest, diagnosis);
  printDurations("Critical path", diagnosis.criticalPath);
  printDurations("Phase durations", diagnosis.phaseDurations);
  printDurations("Tool durations", diagnosis.toolDurations);
  console.log(
    `Usage: ${diagnosis.usage.inputTokens} input, ${diagnosis.usage.outputTokens} output, ${diagnosis.usage.cacheReadTokens} cache read, ${diagnosis.usage.cacheWriteTokens} cache write (${diagnosis.usage.cacheUsageStatus}), $${diagnosis.usage.costUsd}`,
  );
  const cpuMs = (diagnosis.resources.cpuUserMs ?? 0) + (diagnosis.resources.cpuSystemMs ?? 0);
  console.log(
    `Resources: CPU ${cpuMs}ms, peak RSS ${diagnosis.resources.peakRssBytes ?? 0} bytes, ${diagnosis.resources.runtime}`,
  );
  printOptionalDiagnosis(diagnosis);
  printModelAttempts(diagnosis);
  printFailures(diagnosis);
  if (timeline) printTimeline(timeline);
}

function printRunOverview(
  manifest: Parameters<typeof printDiagnosis>[0],
  diagnosis: Parameters<typeof printDiagnosis>[1],
): void {
  console.log(`Execution: ${manifest.executionId}`);
  console.log(`Kind: ${manifest.kind}`);
  console.log(`Outcome: ${manifest.outcome}`);
  console.log(`Duration: ${manifest.durationMs ?? 0}ms`);
  console.log(`Model retries: ${diagnosis.modelRetryAttempts}`);
  console.log(`Agent retries: ${diagnosis.agentRetryAttempts}`);
  console.log(
    `Backoff: ${diagnosis.backoffDurationsMs.length > 0 ? `${diagnosis.backoffDurationsMs.join(", ")}ms` : "none"}`,
  );
  console.log(`Repairs: ${diagnosis.repairAttempts}`);
  console.log(`Validation drops: ${diagnosis.validationDrops}`);
  console.log(`Publication failures: ${diagnosis.publicationFailures}`);
  if (diagnosis.agentRunBudget) {
    console.log(
      `Agent runs: ${diagnosis.agentRunBudget.used}${diagnosis.agentRunBudget.limit === undefined ? "" : `/${diagnosis.agentRunBudget.limit}`}`,
    );
  }
  if (diagnosis.structuralAnalysis) {
    const structural = diagnosis.structuralAnalysis;
    console.log(
      `Structural analysis: ${structural.status}, ${structural.durationMs}ms, ${structural.fileCount} files, ${structural.declarationCount} declarations${structural.reason ? `, ${structural.reason}` : ""}`,
    );
  }
}

function printFailures(diagnosis: ReturnType<typeof diagnoseRunBundle>): void {
  if (diagnosis.failures.length > 0) {
    console.log("Failures:");
    for (const failure of diagnosis.failures) {
      console.log(
        `  ${failure.event}${failure.task ? ` (${failure.task})` : ""}: ${failure.message}`,
      );
    }
  }
}

function printModelAttempts(diagnosis: ReturnType<typeof diagnoseRunBundle>): void {
  console.log("Model attempts:");
  if (diagnosis.modelAttempts.length === 0) console.log("  none");
  for (const attempt of diagnosis.modelAttempts) {
    const shard =
      attempt.shardIndex === undefined
        ? ""
        : ` shard ${attempt.shardIndex}/${attempt.shardCount ?? "?"}`;
    console.log(
      `  ${attempt.agent}${attempt.task ? ` (${attempt.task})` : ""}${shard} ${attempt.provider}/${attempt.model} ${attempt.attemptType}#${attempt.attemptNumber}${attempt.authMode ? ` ${attempt.authMode}` : ""} ${attempt.durationMs}ms ${attempt.status}`,
    );
  }
}

function printDurations(
  label: string,
  entries: Array<{ name: string; durationMs: number; status: string }>,
): void {
  console.log(`${label}:`);
  if (entries.length === 0) console.log("  none");
  for (const entry of entries) {
    console.log(`  ${entry.name} ${entry.durationMs}ms ${entry.status}`);
  }
}

function printOptionalDiagnosis(diagnosis: ReturnType<typeof diagnoseRunBundle>): void {
  if (diagnosis.timeToFirstTokenMs !== undefined) {
    console.log(`Time to first token: ${diagnosis.timeToFirstTokenMs}ms`);
  }
  if (diagnosis.missingEvidence.length > 0) {
    console.log(`Missing evidence: ${diagnosis.missingEvidence.join(", ")}`);
  }
}

function printTimeline(
  timeline: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>["spans"],
): void {
  console.log("Timeline:");
  const ordered = [...timeline].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
  for (const span of ordered) {
    console.log(`  ${span.startedAt} ${span.name} ${span.durationMs ?? 0}ms ${span.status}`);
  }
}
