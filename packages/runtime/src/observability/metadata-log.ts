import type { RunLogRecord } from "@usepipr/sdk";

/**
 * The content-free projection of a run log: only allowlisted events and enum or numeric fields, never free text.
 * Metadata capture writes logs through it, and the protected package checks metadata against it.
 */
const publicLogEvents = new Set([
  "agent run budget",
  "check finalization after failure failed",
  "command dispatch",
  "command terminal status publication failed",
  "config warning",
  "diff manifest",
  "diff manifest sharded",
  "diff structural analysis",
  "dispatch",
  "event",
  "event dispatch",
  "event ignored",
  "host run start",
  "local dispatch",
  "pi run",
  "pi start",
  "publication plan",
  "publication result",
  "review progress failure publication failed",
  "review progress publication is not available for this code host",
  "review validated",
  "review work progress publication failed",
  "run capture artifact failed",
  "task failed",
  "task ok",
  "task start",
  "trusted config",
  "verifier publication",
  "verifier start",
]);

const publicLogPhases = new Set([
  "check command permission",
  "checkout head",
  "fetch trusted base",
  "load change request",
  "load trusted config",
  "parse event",
  "publish verifier thread actions",
  "workspace",
]);

const publicStringLogFields = new Set([
  "agent",
  "attemptId",
  "attemptType",
  "authMode",
  "failureCategory",
  "host",
  "kind",
  "model",
  "outcome",
  "provider",
  "status",
  "task",
]);

const publicNumericLogFields = new Set([
  "agentRunCount",
  "attemptNumber",
  "backoffMs",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
  "contextFilesCovered",
  "contextFilesTotal",
  "contextRangesCovered",
  "contextRangesTotal",
  "declarationCount",
  "droppedFindings",
  "durationMs",
  "excludedCount",
  "exitCode",
  "fileCount",
  "findings",
  "inputTokens",
  "limit",
  "outputTokens",
  "promptBytes",
  "rangeCount",
  "retries",
  "shardCount",
  "shardIndex",
  "used",
]);

export function publicLog(log: RunLogRecord): RunLogRecord | undefined {
  const phaseMatch = /^(.+) (?:start|ok|failed)$/.exec(log.event);
  const phaseEvent = Boolean(phaseMatch?.[1] && publicLogPhases.has(phaseMatch[1]));
  if (!phaseEvent && !publicLogEvents.has(log.event)) return undefined;
  return {
    ...log,
    fields: Object.fromEntries(
      Object.entries(log.fields).filter(
        ([key, value]) =>
          (typeof value === "string" && publicStringLogFields.has(key)) ||
          ((typeof value === "number" || typeof value === "boolean") &&
            publicNumericLogFields.has(key)),
      ),
    ),
    text: undefined,
  };
}
