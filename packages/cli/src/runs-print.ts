import type { RunDiagnosis, RunRecord, ValidatedRunBundle } from "@usepipr/runtime";

const runListColumns: Array<{ header: string; width: number; value: (run: RunRecord) => string }> =
  [
    { header: "EXECUTION ID", width: 32, value: (run) => run.executionId },
    { header: "KIND", width: 9, value: (run) => run.kind ?? "unknown" },
    { header: "OUTCOME", width: 12, value: (run) => run.outcome ?? "unknown" },
    { header: "STATE", width: 21, value: (run) => run.state },
    { header: "PROTECTION", width: 10, value: (run) => run.protection ?? "unknown" },
    { header: "STARTED", width: 25, value: (run) => run.startedAt ?? "unknown" },
  ];

export function printRunList(runs: RunRecord[]): void {
  if (runs.length === 0) {
    console.log("No Pipr runs found.");
    return;
  }
  console.log(
    [...runListColumns.map((column) => padColumn(column.header, column.width)), "LOCATION"].join(
      "  ",
    ),
  );
  for (const run of runs) {
    console.log(
      [
        ...runListColumns.map((column) => padColumn(column.value(run), column.width)),
        run.nativeUrl ?? run.error ?? "-",
      ].join("  "),
    );
  }
}

function padColumn(value: string, width: number): string {
  return value.slice(0, width).padEnd(width);
}

export function printDiagnosis(
  manifest: ValidatedRunBundle["manifest"],
  diagnosis: RunDiagnosis,
  timeline?: ValidatedRunBundle["spans"],
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

function printRunOverview(manifest: ValidatedRunBundle["manifest"], diagnosis: RunDiagnosis): void {
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

function printFailures(diagnosis: RunDiagnosis): void {
  if (diagnosis.failures.length > 0) {
    console.log("Failures:");
    for (const failure of diagnosis.failures) {
      console.log(
        `  ${failure.event}${failure.task ? ` (${failure.task})` : ""}: ${failure.message}`,
      );
    }
  }
}

function printModelAttempts(diagnosis: RunDiagnosis): void {
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

function printOptionalDiagnosis(diagnosis: RunDiagnosis): void {
  if (diagnosis.timeToFirstTokenMs !== undefined) {
    console.log(`Time to first token: ${diagnosis.timeToFirstTokenMs}ms`);
  }
  if (diagnosis.missingEvidence.length > 0) {
    console.log(`Missing evidence: ${diagnosis.missingEvidence.join(", ")}`);
  }
}

function printTimeline(timeline: ValidatedRunBundle["spans"]): void {
  console.log("Timeline:");
  const ordered = [...timeline].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
  for (const span of ordered) {
    console.log(`  ${span.startedAt} ${span.name} ${span.durationMs ?? 0}ms ${span.status}`);
  }
}
