import type { RunBundleArtifact, RunMetricsSnapshot } from "@usepipr/sdk";
import type { RunRecorderFinish } from "./recorder-types.js";

export function truncateUtf8(contents: Buffer, maxBytes: number): Buffer {
  if (contents.byteLength <= maxBytes) return contents;
  let end = Math.max(0, maxBytes);
  while (end > 0) {
    const candidate = Buffer.from(contents.subarray(0, end).toString("utf8"), "utf8");
    if (candidate.byteLength <= maxBytes) return candidate;
    end -= 1;
  }
  return Buffer.alloc(0);
}

export function artifactPriority(kind: RunBundleArtifact["kind"], name: string): number {
  if (kind === "validation") return 1_000_000;
  if (kind === "publication-plan") {
    return /publication-(?:result|error)\.json$/.test(name) ? 1_010_000 : 990_000;
  }
  if (kind === "diff-manifest") return 980_000;
  const attempt = /-(\d+)-(?:initial|retry|repair|fallback)\./.exec(name);
  if (!attempt) return 970_000;
  const sequence = Number(attempt[1]);
  const kindPriority = kind === "stderr" ? 3 : kind === "output" ? 2 : 1;
  return sequence * 10 + kindPriority;
}

export function emptyMetrics(): RunMetricsSnapshot {
  return { formatVersion: 1, counters: [], histograms: [] };
}

export function runMetrics(result: RunRecorderFinish, durationMs: number): RunMetricsSnapshot {
  const attributes = { runKind: result.kind, outcome: result.outcome } as const;
  return {
    formatVersion: 1,
    counters: [{ name: "pipr.run.count", value: 1, attributes }],
    histograms: [
      {
        name: "pipr.run.duration",
        count: 1,
        sum: durationMs,
        min: durationMs,
        max: durationMs,
        attributes,
      },
    ],
  };
}
