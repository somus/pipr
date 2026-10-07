import type { ReviewFinding } from "@usepipr/sdk";
import type { PriorFindingRecord, PriorReviewState, ReviewStats } from "../publication/types.js";
import { accumulateReviewStats } from "./review-stats.js";

type BuildFindingRecordOptions = {
  finding: ReviewFinding;
  findings: ReviewFinding[];
  priorFindings: Map<string, PriorFindingRecord>;
  usedPriorIds: Set<string>;
  reviewedHeadSha: string;
  anchorFingerprint?: string;
  issueFingerprint?: string;
  previousPath?: string;
  fingerprintCounts: Map<string, number>;
};

type PriorFindingInput = {
  finding: ReviewFinding;
  anchorFingerprint?: string;
  issueFingerprint?: string;
  previousPath?: string;
};

export function buildPriorReviewState(options: {
  priorState?: PriorReviewState;
  findings: PriorFindingInput[];
  reviewedHeadSha: string;
  selectedTasks: string[];
  stats?: ReviewStats;
  workflowUrl?: string;
}): PriorReviewState {
  const scopedPriorState = priorReviewStateForSelectedTasks(
    options.priorState,
    options.selectedTasks,
  );
  const priorFindings = new Map(
    (scopedPriorState?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const nextFindings = new Map<string, PriorFindingRecord>();
  const usedPriorIds = new Set<string>();
  const stats = accumulateReviewStats(scopedPriorState?.stats, options.stats);
  const workflowUrls = [
    ...new Set([
      ...(scopedPriorState?.workflowUrls ?? []),
      ...(options.workflowUrl ? [options.workflowUrl] : []),
    ]),
  ];
  const findings = options.findings.map((item) => item.finding);
  const fingerprintCounts = countFindingFingerprints(options.findings);

  for (const { finding, anchorFingerprint, issueFingerprint, previousPath } of options.findings) {
    const record = buildFindingRecord({
      finding,
      findings,
      priorFindings,
      usedPriorIds,
      reviewedHeadSha: options.reviewedHeadSha,
      anchorFingerprint,
      issueFingerprint,
      previousPath,
      fingerprintCounts,
    });
    nextFindings.set(record.id, record);
  }
  addHistoricalFindings(nextFindings, priorFindings.values());

  return {
    version: 1,
    reviewedHeadSha: options.reviewedHeadSha,
    selectedTasks: options.selectedTasks,
    findings: [...nextFindings.values()],
    ...(stats ? { stats } : {}),
    ...(workflowUrls.length > 0 ? { workflowUrls } : {}),
  };
}

function buildFindingRecord(options: BuildFindingRecordOptions): PriorFindingRecord {
  const selection = selectPriorFindingRecord(options);
  const prior = options.priorFindings.get(selection.id);
  markPriorFindingUsed(options.usedPriorIds, prior);
  return {
    id: selection.id,
    ...findingIdentity(options.anchorFingerprint, options.issueFingerprint),
    status: selection.status,
    path: options.finding.path,
    rangeId: options.finding.rangeId,
    side: options.finding.side,
    startLine: options.finding.startLine,
    endLine: options.finding.endLine,
    ...findingHistory(prior, options.reviewedHeadSha),
  };
}

function selectPriorFindingRecord(options: BuildFindingRecordOptions): {
  id: string;
  status: PriorFindingRecord["status"];
} {
  const resolvedMatch = matchResolvedFindingRecord(
    [...options.priorFindings.values()],
    options.finding,
    options.anchorFingerprint,
    options.issueFingerprint,
    options.fingerprintCounts,
    options.previousPath,
  );
  if (resolvedMatch) {
    return { id: resolvedMatch.id, status: "resolved" };
  }
  return {
    id: selectFindingId({
      finding: options.finding,
      findings: options.findings,
      priorFindings: options.priorFindings,
      usedPriorIds: options.usedPriorIds,
    }),
    status: "open",
  };
}

function markPriorFindingUsed(
  usedPriorIds: Set<string>,
  prior: PriorFindingRecord | undefined,
): void {
  if (prior) {
    usedPriorIds.add(prior.id);
  }
}

function findingIdentity(
  anchorFingerprint: string | undefined,
  issueFingerprint: string | undefined,
): Pick<PriorFindingRecord, "anchorFingerprint" | "issueFingerprint"> {
  return {
    ...(anchorFingerprint ? { anchorFingerprint } : {}),
    ...(issueFingerprint ? { issueFingerprint } : {}),
  };
}

function findingHistory(
  prior: PriorFindingRecord | undefined,
  reviewedHeadSha: string,
): Pick<PriorFindingRecord, "firstSeenHeadSha" | "lastSeenHeadSha" | "lastCommentedHeadSha"> {
  return {
    firstSeenHeadSha: prior?.firstSeenHeadSha ?? reviewedHeadSha,
    lastSeenHeadSha: reviewedHeadSha,
    ...(prior?.lastCommentedHeadSha ? { lastCommentedHeadSha: prior.lastCommentedHeadSha } : {}),
  };
}

function addHistoricalFindings(
  findings: Map<string, PriorFindingRecord>,
  historicalFindings: Iterable<PriorFindingRecord>,
): void {
  for (const finding of historicalFindings) {
    if (!findings.has(finding.id)) {
      findings.set(finding.id, finding);
    }
  }
}

export function resolvePriorFindings(
  state: PriorReviewState,
  findingIds: Iterable<string>,
): PriorReviewState {
  const resolved = new Set(findingIds);
  return {
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      status: resolved.has(finding.id) ? "resolved" : finding.status,
    })),
  };
}

export function priorReviewStateForSelectedTasks(
  state: PriorReviewState | undefined,
  selectedTasks: string[],
): PriorReviewState | undefined {
  if (
    !state ||
    state.selectedTasks.length !== selectedTasks.length ||
    !state.selectedTasks.every((taskName, index) => taskName === selectedTasks[index])
  ) {
    return undefined;
  }
  return state;
}

export function matchFindingRecord(
  state: PriorReviewState,
  finding: ReviewFinding,
): PriorFindingRecord | undefined {
  const deterministic = state.findings.find((record) => record.id === newFindingId(finding));
  if (deterministic) {
    return deterministic;
  }
  return findOpenOverlappingFinding(state.findings, finding);
}

export function matchResolvedFindingRecord(
  records: PriorFindingRecord[],
  finding: Pick<ReviewFinding, "path">,
  anchorFingerprint: string | undefined,
  issueFingerprint: string | undefined,
  currentFingerprintCounts?: Map<string, number>,
  previousPath?: string,
): PriorFindingRecord | undefined {
  if (
    !anchorFingerprint ||
    !issueFingerprint ||
    (currentFingerprintCounts?.get(
      findingFingerprintKey(finding.path, anchorFingerprint, issueFingerprint),
    ) ?? 1) !== 1
  ) {
    return undefined;
  }
  const candidates = records.filter(
    (record) =>
      record.anchorFingerprint === anchorFingerprint &&
      record.issueFingerprint === issueFingerprint &&
      (record.path === finding.path || record.path === previousPath),
  );
  return candidates.length === 1 && candidates[0]?.status === "resolved"
    ? candidates[0]
    : undefined;
}

export function countFindingFingerprints(
  findings: Iterable<Pick<PriorFindingInput, "finding" | "anchorFingerprint" | "issueFingerprint">>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { finding, anchorFingerprint, issueFingerprint } of findings) {
    if (anchorFingerprint && issueFingerprint) {
      const key = findingFingerprintKey(finding.path, anchorFingerprint, issueFingerprint);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function findingFingerprintKey(
  path: string,
  anchorFingerprint: string,
  issueFingerprint: string,
): string {
  return `${path}\0${anchorFingerprint}\0${issueFingerprint}`;
}

export function applyNativeThreadResolutions(
  state: PriorReviewState,
  resolutions: Array<{
    findingId: string;
    findingHeadSha: string;
    resolved: boolean;
  }>,
): PriorReviewState {
  const resolutionByFinding = new Map(
    resolutions.map((resolution) => [
      `${resolution.findingId}:${resolution.findingHeadSha}`,
      resolution.resolved,
    ]),
  );
  return {
    ...state,
    findings: state.findings.map((finding) => {
      if (!finding.lastCommentedHeadSha) {
        return finding;
      }
      const resolved = resolutionByFinding.get(`${finding.id}:${finding.lastCommentedHeadSha}`);
      return resolved === undefined
        ? finding
        : { ...finding, status: resolved ? "resolved" : "open" };
    }),
  };
}

/** Returns the matched prior record's id, or the deterministic id for a new finding. */
export function findingIdFor(finding: ReviewFinding, matched?: PriorFindingRecord): string {
  return matched?.id ?? newFindingId(finding);
}

function selectFindingId(options: {
  finding: ReviewFinding;
  findings: ReviewFinding[];
  priorFindings: Map<string, PriorFindingRecord>;
  usedPriorIds: Set<string>;
}): string {
  const candidateIds = [
    newFindingId(options.finding),
    findUnambiguousOverlappingFinding(options)?.id,
  ];
  for (const id of new Set(candidateIds)) {
    if (id && options.priorFindings.has(id) && !options.usedPriorIds.has(id)) {
      return id;
    }
  }
  return newFindingId(options.finding);
}

function findUnambiguousOverlappingFinding(options: {
  finding: ReviewFinding;
  findings: ReviewFinding[];
  priorFindings: Map<string, PriorFindingRecord>;
  usedPriorIds: Set<string>;
}): PriorFindingRecord | undefined {
  const candidates = [...options.priorFindings.values()].filter(
    (record) =>
      !options.usedPriorIds.has(record.id) && findingOverlapsRecord(options.finding, record),
  );
  if (candidates.length !== 1) {
    return undefined;
  }
  const [candidate] = candidates;
  const currentOverlaps = options.findings.filter((finding) =>
    findingOverlapsRecord(finding, candidate),
  );
  return currentOverlaps.length === 1 ? candidate : undefined;
}

function findOpenOverlappingFinding(
  records: PriorFindingRecord[],
  finding: ReviewFinding,
): PriorFindingRecord | undefined {
  const candidates = records.filter((record) => findingOverlapsRecord(finding, record));
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findingOverlapsRecord(finding: ReviewFinding, record: PriorFindingRecord): boolean {
  return (
    record.status === "open" &&
    record.path === finding.path &&
    record.side === finding.side &&
    record.startLine <= finding.endLine &&
    finding.startLine <= record.endLine
  );
}

function newFindingId(finding: ReviewFinding): string {
  return `fnd_${findingContentHash(finding)}`;
}

/** Hash of a finding's location and body; prefixed with `fnd_` it is the deterministic finding id. */
export function findingContentHash(finding: ReviewFinding): string {
  const basis = [
    finding.path,
    finding.rangeId,
    finding.side,
    `${finding.startLine}-${finding.endLine}`,
    finding.body,
  ].join("\n");
  return new Bun.CryptoHasher("sha256").update(basis).digest("hex").slice(0, 16);
}
