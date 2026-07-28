import type { DiffManifest } from "../types.js";
import type {
  DiffContextCoverageObservation,
  DiffContextCoverageTracker,
} from "./diff-context-coverage.js";

type CoverageFileState = {
  path: string;
  rangeIds: Set<string>;
  coveredRangeIds: Set<string>;
  fullFile: boolean;
};

type PendingToolCall = {
  name: string;
  args?: Record<string, unknown>;
};

export function createDiffContextCoverageTracker(options: {
  manifest: DiffManifest;
  mode: "full" | "condensed";
}): DiffContextCoverageTracker {
  const pending = new Map<string, PendingToolCall>();
  const files = coverageFiles(options.manifest, options.mode);
  return {
    observe(event) {
      observeCoverageEvent(pending, files, event);
    },
    result() {
      return coverageObservation(files);
    },
  };
}

function coverageFiles(
  manifest: DiffManifest,
  mode: "full" | "condensed",
): Map<string, CoverageFileState> {
  return new Map(
    manifest.files.map((file) => [
      file.path,
      {
        path: file.path,
        rangeIds: new Set(file.commentableRanges.map((range) => range.id)),
        coveredRangeIds: new Set(
          mode === "full" ? file.commentableRanges.map((range) => range.id) : [],
        ),
        fullFile: mode === "full",
      },
    ]),
  );
}

function coverageObservation(
  files: Map<string, CoverageFileState>,
): DiffContextCoverageObservation {
  return {
    files: [...files.values()].map((file) => ({
      path: file.path,
      rangeIds: [...file.rangeIds],
      coveredRangeIds: [...file.coveredRangeIds],
      fullFile: file.fullFile,
    })),
  };
}

function observeCoverageEvent(
  pending: Map<string, PendingToolCall>,
  files: Map<string, CoverageFileState>,
  event: Record<string, unknown>,
): void {
  const id = eventId(event);
  if (!id) return;
  if (event.type === "tool_execution_start") {
    pending.set(id, {
      name: eventToolName(event),
      args: asRecord(event.args ?? event.input ?? event.arguments),
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    recordCompletedCoverageRead(pending, files, id, event);
  }
}

function recordCompletedCoverageRead(
  pending: Map<string, PendingToolCall>,
  files: Map<string, CoverageFileState>,
  id: string,
  event: Record<string, unknown>,
): void {
  const call = pending.get(id);
  pending.delete(id);
  if (!call || event.isError === true || event.error === true) return;
  const details = toolResultDetails(event.result ?? event.output);
  if (!details) return;
  if (call.name === "pipr_read_diff") {
    recordDiffRead(files, call.args, details);
  } else if (call.name === "pipr_read_at_ref" || call.name === "pipr_read_declaration") {
    recordRangeRead(files, details);
  }
}

function recordDiffRead(
  files: Map<string, CoverageFileState>,
  args: Record<string, unknown> | undefined,
  details: Record<string, unknown>,
): void {
  const observedFiles = completedDiffReadFiles(details);
  if (!observedFiles) return;
  const rangeScoped = typeof args?.rangeId === "string";
  for (const observed of observedFiles) {
    const file = files.get(observed.path);
    if (!file) continue;
    if (!rangeScoped) file.fullFile = true;
    for (const rangeId of observed.rangeIds) {
      if (file.rangeIds.has(rangeId)) file.coveredRangeIds.add(rangeId);
    }
  }
}

function completedDiffReadFiles(
  details: Record<string, unknown>,
): Array<{ path: string; rangeIds: string[] }> | undefined {
  if (details.truncated !== false) return undefined;
  const value = asRecord(details.value);
  if (!Array.isArray(value?.files)) return undefined;
  return value.files.flatMap((item) => {
    const observed = asRecord(item);
    if (!observed || typeof observed.path !== "string") return [];
    const ranges = Array.isArray(observed.commentableRanges) ? observed.commentableRanges : [];
    return [
      {
        path: observed.path,
        rangeIds: ranges
          .map(asRecord)
          .map((range) => range?.id)
          .filter((rangeId): rangeId is string => typeof rangeId === "string"),
      },
    ];
  });
}

function recordRangeRead(
  files: Map<string, CoverageFileState>,
  details: Record<string, unknown>,
): void {
  if (
    details.available !== true ||
    details.truncated !== false ||
    typeof details.path !== "string" ||
    typeof details.rangeId !== "string"
  ) {
    return;
  }
  const file = files.get(details.path);
  if (file?.rangeIds.has(details.rangeId)) {
    file.coveredRangeIds.add(details.rangeId);
  }
}

function toolResultDetails(value: unknown): Record<string, unknown> | undefined {
  const result = asRecord(value);
  if (!result) return undefined;
  const details = asRecord(result.details);
  if (details) return details;
  if (!Array.isArray(result.content)) return result;
  const text = result.content
    .map(asRecord)
    .find((item) => item?.type === "text" && typeof item.text === "string")?.text;
  if (typeof text !== "string") return result;
  try {
    return asRecord(JSON.parse(text) as unknown) ?? result;
  } catch {
    return result;
  }
}

function eventId(event: Record<string, unknown>): string | undefined {
  for (const key of ["toolCallId", "tool_call_id", "id"]) {
    if (typeof event[key] === "string" && event[key].length > 0) return event[key];
  }
  return undefined;
}

function eventToolName(event: Record<string, unknown>): string {
  for (const key of ["toolName", "tool_name", "name"]) {
    if (typeof event[key] === "string") return event[key];
  }
  return "";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
