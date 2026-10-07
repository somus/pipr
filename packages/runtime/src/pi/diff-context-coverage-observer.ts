import { z } from "zod";
import type { AgentWorkerEvent } from "../agent-worker/protocol.js";
import type { DiffManifest } from "../types.js";
import type { DiffContextCoverageObservation } from "./diff-context-coverage.js";

type CoverageFileState = {
  path: string;
  rangeIds: Set<string>;
  coveredRangeIds: Set<string>;
  fullFile: boolean;
};

type ToolEndEvent = Extract<AgentWorkerEvent, { type: "tool_execution_end" }>;

/** `pipr_read_diff` details: the bounded read of the full Diff Manifest. */
const diffReadDetailsSchema = z.object({
  truncated: z.literal(false),
  value: z.object({
    files: z.array(
      z.object({
        path: z.string(),
        commentableRanges: z.array(z.object({ id: z.string() })),
      }),
    ),
  }),
});

/** `pipr_read_at_ref` and `pipr_read_declaration` details for a complete range read. */
const rangeReadDetailsSchema = z.object({
  available: z.literal(true),
  truncated: z.literal(false),
  path: z.string(),
  rangeId: z.string(),
});

export function createDiffContextCoverageTracker(options: {
  manifest: DiffManifest;
  mode: "full" | "condensed";
}): {
  observe(event: AgentWorkerEvent): void;
  result(): DiffContextCoverageObservation;
} {
  const pendingArgs = new Map<string, unknown>();
  const files = coverageFiles(options.manifest, options.mode);
  return {
    observe(event) {
      if (event.type === "tool_execution_start") {
        pendingArgs.set(event.toolCallId, event.args);
      } else if (event.type === "tool_execution_end" && pendingArgs.has(event.toolCallId)) {
        const args = pendingArgs.get(event.toolCallId);
        pendingArgs.delete(event.toolCallId);
        if (!event.isError) recordCompletedRead(files, args, event);
      }
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

function recordCompletedRead(
  files: Map<string, CoverageFileState>,
  args: unknown,
  event: ToolEndEvent,
): void {
  if (event.toolName === "pipr_read_diff") {
    recordDiffRead(files, isRangeScoped(args), event.result.details);
  } else if (event.toolName === "pipr_read_at_ref" || event.toolName === "pipr_read_declaration") {
    recordRangeRead(files, event.result.details);
  }
}

function recordDiffRead(
  files: Map<string, CoverageFileState>,
  rangeScoped: boolean,
  details: unknown,
): void {
  const parsed = diffReadDetailsSchema.safeParse(details);
  if (!parsed.success) return;
  for (const observed of parsed.data.value.files) {
    const file = files.get(observed.path);
    if (!file) continue;
    if (!rangeScoped) file.fullFile = true;
    for (const { id } of observed.commentableRanges) {
      if (file.rangeIds.has(id)) file.coveredRangeIds.add(id);
    }
  }
}

function recordRangeRead(files: Map<string, CoverageFileState>, details: unknown): void {
  const parsed = rangeReadDetailsSchema.safeParse(details);
  if (!parsed.success) return;
  const file = files.get(parsed.data.path);
  if (file?.rangeIds.has(parsed.data.rangeId)) file.coveredRangeIds.add(parsed.data.rangeId);
}

function isRangeScoped(args: unknown): boolean {
  return (
    typeof args === "object" &&
    args !== null &&
    "rangeId" in args &&
    typeof args.rangeId === "string"
  );
}
