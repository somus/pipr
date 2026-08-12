import type { RunLogRecord } from "@usepipr/sdk";
import type { RuntimeLogRecord, RuntimeLogSink } from "../shared/logging.js";
import type { createKnownSecretRedactor } from "../shared/secret-redactor.js";

export function combineRuntimeLogSinks(
  first: RuntimeLogSink | undefined,
  second: RuntimeLogSink | undefined,
): RuntimeLogSink | undefined {
  if (!first) return second;
  if (!second) return first;
  return {
    log(record) {
      first.log(record);
      second.log(record);
    },
    async group(name, run) {
      return await first.group(name, async () => await second.group(name, run));
    },
  };
}

export function normalizeLogFields(
  fields: RuntimeLogRecord["fields"],
  redactor: ReturnType<typeof createKnownSecretRedactor>,
  onTruncate: () => void,
): RunLogRecord["fields"] {
  const redacted: RunLogRecord["fields"] = {};
  for (const [key, value] of Object.entries(fields)) {
    const boundedKey = boundLogString(key, 200, onTruncate);
    if (!boundedKey) continue;
    redacted[boundedKey] =
      typeof value === "string"
        ? boundLogString(redactor.redact(value).value, 2000, onTruncate)
        : typeof value === "number" || typeof value === "boolean"
          ? value
          : normalizeLogArray(value, redactor, onTruncate);
  }
  return redacted;
}

function normalizeLogArray(
  value: readonly string[],
  redactor: ReturnType<typeof createKnownSecretRedactor>,
  onTruncate: () => void,
): string[] {
  if (value.length > 100) onTruncate();
  return value
    .slice(0, 100)
    .map((item) => boundLogString(redactor.redact(item).value, 2000, onTruncate));
}

export function boundLogString(value: string, maximum: number, onTruncate: () => void): string {
  if (value.length <= maximum) return value;
  onTruncate();
  return value.slice(0, maximum);
}
