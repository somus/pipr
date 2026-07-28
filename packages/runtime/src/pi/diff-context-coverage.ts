import { Buffer } from "node:buffer";

export { createDiffContextCoverageTracker } from "./diff-context-coverage-observer.js";

export type DiffContextCoverageSummary = {
  files: { total: number; covered: number };
  ranges: { total: number; covered: number };
};

export type DiffContextCoverageObservation = {
  files: Array<{
    path: string;
    rangeIds: string[];
    coveredRangeIds: string[];
    fullFile: boolean;
  }>;
};

export type DiffContextCoverageTracker = {
  observe(event: Record<string, unknown>): void;
  result(): DiffContextCoverageObservation;
};

export function summarizeDiffContextCoverage(
  observations: readonly DiffContextCoverageObservation[],
): DiffContextCoverageSummary {
  const files = mergeDiffContextCoverage(observations);
  const ranges = [...files.values()].reduce(
    (totals, file) => ({
      total: totals.total + file.rangeIds.size,
      covered:
        totals.covered +
        [...file.rangeIds].filter((rangeId) => file.coveredRangeIds.has(rangeId)).length,
    }),
    { total: 0, covered: 0 },
  );
  return {
    files: {
      total: files.size,
      covered: [...files.values()].filter(
        (file) =>
          file.fullFile ||
          (file.rangeIds.size > 0 &&
            [...file.rangeIds].every((rangeId) => file.coveredRangeIds.has(rangeId))),
      ).length,
    },
    ranges,
  };
}

export function diffContextCoverageArtifact(
  observations: readonly DiffContextCoverageObservation[],
): string | undefined {
  if (observations.length === 0) return undefined;
  const files = mergeDiffContextCoverage(observations);
  const entries = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, file]) => ({
      path,
      fullFile: file.fullFile,
      covered:
        file.fullFile ||
        (file.rangeIds.size > 0 &&
          [...file.rangeIds].every((rangeId) => file.coveredRangeIds.has(rangeId))),
      ranges: [...file.rangeIds]
        .sort()
        .map((id) => ({ id, covered: file.coveredRangeIds.has(id) })),
    }));
  const payload = {
    formatVersion: 1,
    truncated: false,
    omittedFiles: 0,
    files: [] as typeof entries,
  };
  const maximumBytes = 1024 * 1024;
  for (const entry of entries) {
    payload.files.push(entry);
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") <= maximumBytes) continue;
    payload.files.pop();
    payload.truncated = true;
    payload.omittedFiles = entries.length - payload.files.length;
    break;
  }
  return JSON.stringify(payload);
}

function mergeDiffContextCoverage(
  observations: readonly DiffContextCoverageObservation[],
): Map<string, { rangeIds: Set<string>; coveredRangeIds: Set<string>; fullFile: boolean }> {
  const files = new Map<
    string,
    { rangeIds: Set<string>; coveredRangeIds: Set<string>; fullFile: boolean }
  >();
  for (const observation of observations) {
    for (const observed of observation.files) {
      const file = files.get(observed.path) ?? {
        rangeIds: new Set<string>(),
        coveredRangeIds: new Set<string>(),
        fullFile: false,
      };
      for (const rangeId of observed.rangeIds) file.rangeIds.add(rangeId);
      for (const rangeId of observed.coveredRangeIds) file.coveredRangeIds.add(rangeId);
      file.fullFile ||= observed.fullFile;
      files.set(observed.path, file);
    }
  }
  return files;
}
