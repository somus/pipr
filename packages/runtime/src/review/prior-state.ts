import { Buffer } from "node:buffer";
import type { ReviewFinding } from "@usepipr/sdk";
import { defaultMaxStoredFindings } from "@usepipr/sdk/internal";
import { z } from "zod";
import { firstNonEmptyLine } from "../commands/grammar.js";
import { reviewSideSchema } from "../types.js";
import { accumulateReviewStats, type ReviewStats, reviewStatsSchema } from "./review-stats.js";

export const mainCommentMarker = "pipr:main-comment";
const inlineFindingMarkerPrefix = "pipr:finding";
const resolvedFindingMarkerPrefix = "pipr:resolved";
const verifierResponseMarkerPrefix = "pipr:verifier-response";

export const findingIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/);

const priorFindingStatusSchema = z.enum(["open", "resolved"]);

const priorFindingRecordSchema = z.strictObject({
  id: findingIdSchema,
  anchorFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  status: priorFindingStatusSchema,
  path: z.string().min(1),
  rangeId: z.string().min(1),
  side: reviewSideSchema,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  firstSeenHeadSha: z.string().min(1),
  lastSeenHeadSha: z.string().min(1),
  lastCommentedHeadSha: z.string().min(1).optional(),
});

export const priorReviewStateSchema = z.strictObject({
  version: z.literal(1),
  reviewedHeadSha: z.string().min(1),
  selectedTasks: z.array(z.string().min(1)),
  findings: z.array(priorFindingRecordSchema),
  stats: reviewStatsSchema.optional(),
});

export type PriorFindingRecord = z.infer<typeof priorFindingRecordSchema>;
export type PriorReviewState = z.infer<typeof priorReviewStateSchema>;
export type FindingMarkerRecord = {
  id: string;
  head: string;
  marker: string;
};

type BuildFindingRecordOptions = {
  finding: ReviewFinding;
  findings: ReviewFinding[];
  priorFindings: Map<string, PriorFindingRecord>;
  usedPriorIds: Set<string>;
  reviewedHeadSha: string;
  anchorFingerprint?: string;
  previousPath?: string;
  fingerprintCounts: Map<string, number>;
};

type PriorFindingInput = {
  finding: ReviewFinding;
  anchorFingerprint?: string;
  previousPath?: string;
};

export function buildPriorReviewState(options: {
  priorState?: PriorReviewState;
  findings: PriorFindingInput[];
  reviewedHeadSha: string;
  selectedTasks: string[];
  stats?: ReviewStats;
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
  const findings = options.findings.map((item) => item.finding);
  const fingerprintCounts = countFindingFingerprints(options.findings);

  for (const { finding, anchorFingerprint, previousPath } of options.findings) {
    const record = buildFindingRecord({
      finding,
      findings,
      priorFindings,
      usedPriorIds,
      reviewedHeadSha: options.reviewedHeadSha,
      anchorFingerprint,
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
  };
}

function buildFindingRecord(options: BuildFindingRecordOptions): PriorFindingRecord {
  const selection = selectPriorFindingRecord(options);
  const prior = options.priorFindings.get(selection.id);
  markPriorFindingUsed(options.usedPriorIds, prior);
  return {
    id: selection.id,
    ...findingIdentity(options.anchorFingerprint),
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
): Pick<PriorFindingRecord, "anchorFingerprint"> {
  return {
    ...(anchorFingerprint ? { anchorFingerprint } : {}),
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
  currentFingerprintCounts?: Map<string, number>,
  previousPath?: string,
): PriorFindingRecord | undefined {
  if (
    !anchorFingerprint ||
    (currentFingerprintCounts?.get(findingFingerprintKey(finding.path, anchorFingerprint)) ?? 1) !==
      1
  ) {
    return undefined;
  }
  const candidates = records.filter(
    (record) =>
      record.anchorFingerprint === anchorFingerprint &&
      (record.path === finding.path || record.path === previousPath),
  );
  return candidates.length === 1 && candidates[0]?.status === "resolved"
    ? candidates[0]
    : undefined;
}

export function countFindingFingerprints(
  findings: Iterable<Pick<PriorFindingInput, "finding" | "anchorFingerprint">>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const { finding, anchorFingerprint } of findings) {
    if (anchorFingerprint) {
      const key = findingFingerprintKey(finding.path, anchorFingerprint);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

function findingFingerprintKey(path: string, anchorFingerprint: string): string {
  return `${path}\0${anchorFingerprint}`;
}

export function renderMainCommentMarker(options: {
  marker: string;
  changeNumber: number;
  reviewState: PriorReviewState;
  maxStoredFindings?: number;
}): string {
  return `<!-- ${options.marker} change=${options.changeNumber} version=1 state=${encodeReviewState(
    {
      ...options.reviewState,
      findings: options.reviewState.findings.slice(
        0,
        options.maxStoredFindings ?? defaultMaxStoredFindings,
      ),
    },
  )} -->`;
}

export function extractPriorReviewState(
  body: string | null | undefined,
  changeNumber: number,
  marker = mainCommentMarker,
): PriorReviewState | undefined {
  const parsed = parseMainCommentMarker(body ? firstNonEmptyLine(body) : undefined);
  if (!parsed || parsed.marker !== marker || parsed.changeNumber !== changeNumber) {
    return undefined;
  }
  return parsed.state;
}

function parseMainCommentMarker(
  line: string | undefined,
): { marker: string; changeNumber: number; state: PriorReviewState } | undefined {
  const identity = parseMainCommentIdentity(line);
  if (!identity) {
    return undefined;
  }
  const state = decodeReviewState(identity.attrs.state);
  if (!state) {
    return undefined;
  }
  return { marker: identity.marker, changeNumber: identity.changeNumber, state };
}

export function parseMainCommentIdentity(
  line: string | undefined,
): { marker: string; changeNumber: number; attrs: Record<string, string> } | undefined {
  const parsed = parsePiprMarker(line);
  if (!parsed) {
    return undefined;
  }
  const changeNumber = Number(parsed.attrs.change);
  if (!Number.isInteger(changeNumber) || changeNumber <= 0 || parsed.attrs.version !== "1") {
    return undefined;
  }
  return { marker: parsed.name, changeNumber, attrs: parsed.attrs };
}

export function inlineFindingMarker(findingId: string, reviewedHeadSha: string): string {
  return `${inlineFindingMarkerPrefix}:${findingId}:${reviewedHeadSha}`;
}

export function renderInlineFindingMarker(findingId: string, reviewedHeadSha: string): string {
  return `<!-- ${inlineFindingMarkerPrefix} id=${findingId} head=${reviewedHeadSha} -->`;
}

export function renderResolvedFindingMarker(findingId: string, reviewedHeadSha: string): string {
  return `<!-- ${resolvedFindingMarkerPrefix} id=${findingId} head=${reviewedHeadSha} -->`;
}

export function renderVerifierResponseMarker(findingId: string, responseKey: string): string {
  return `<!-- ${verifierResponseMarkerPrefix} id=${findingId} key=${responseKey} -->`;
}

export function extractInlineFindingMarkerRecords(commentBodies: string[]): FindingMarkerRecord[] {
  return extractMarkerRecords(commentBodies, inlineFindingMarkerPrefix);
}

export function extractInlineFindingMarkers(commentBodies: string[]): Set<string> {
  return new Set(extractInlineFindingMarkerRecords(commentBodies).map((record) => record.marker));
}

export function extractResolvedFindingMarkerRecords(
  commentBodies: string[],
): FindingMarkerRecord[] {
  return extractMarkerRecords(commentBodies, resolvedFindingMarkerPrefix);
}

export function applyResolvedFindingMarkers(
  state: PriorReviewState,
  commentBodies: string[],
): PriorReviewState {
  const resolvedMarkers = new Set(
    extractResolvedFindingMarkerRecords(commentBodies).map(
      (record) => `${record.id}:${record.head}`,
    ),
  );
  return {
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      status:
        finding.lastCommentedHeadSha &&
        resolvedMarkers.has(`${finding.id}:${finding.lastCommentedHeadSha}`)
          ? "resolved"
          : finding.status,
    })),
  };
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

export function extractVerifierResponseMarkers(commentBodies: string[]): Set<string> {
  return new Set(
    extractMarkerRecords(commentBodies, verifierResponseMarkerPrefix).map(
      (record) => record.marker,
    ),
  );
}

export function isPiprThreadActionReplyBody(body: string | null | undefined): boolean {
  const parsed = parsePiprMarker(body ? firstNonEmptyLine(body) : undefined);
  return (
    parsed?.name === resolvedFindingMarkerPrefix || parsed?.name === verifierResponseMarkerPrefix
  );
}

export function applyInlineFindingMarkers(
  state: PriorReviewState,
  commentBodies: string[],
): PriorReviewState {
  const markerById = new Map<string, string>();
  for (const marker of extractInlineFindingMarkers(commentBodies)) {
    const [, , findingId, headSha] = marker.split(":");
    if (findingId && headSha) {
      markerById.set(findingId, headSha);
    }
  }
  return {
    ...state,
    findings: state.findings.map((finding) => {
      const headSha = markerById.get(finding.id);
      const { lastCommentedHeadSha: _lastCommentedHeadSha, ...rest } = finding;
      return headSha ? { ...rest, lastCommentedHeadSha: headSha } : rest;
    }),
  };
}

export function findingIdFor(finding: ReviewFinding, state?: PriorReviewState): string {
  const matched = state ? matchFindingRecord(state, finding) : undefined;
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
  return `fnd_${hashParts([
    finding.path,
    finding.rangeId,
    finding.side,
    `${finding.startLine}-${finding.endLine}`,
    finding.body,
  ])}`;
}

function parseFindingHeadMarker(
  comment: string | undefined,
  prefix: string,
): FindingMarkerRecord | undefined {
  const parsed = parsePiprMarker(comment);
  if (!parsed || parsed.name !== prefix) {
    return undefined;
  }
  const id = parsed.attrs.id;
  const head = parsed.attrs.head ?? parsed.attrs.key;
  if (!id || !head || !findingIdSchema.safeParse(id).success) {
    return undefined;
  }
  return {
    id,
    head,
    marker:
      prefix === inlineFindingMarkerPrefix
        ? inlineFindingMarker(id, head)
        : prefix === resolvedFindingMarkerPrefix
          ? `${resolvedFindingMarkerPrefix}:${id}:${head}`
          : `${verifierResponseMarkerPrefix}:${id}:${head}`,
  };
}

function extractMarkerRecords(commentBodies: string[], prefix: string): FindingMarkerRecord[] {
  return commentBodies.flatMap((body) =>
    [parseFindingHeadMarker(firstNonEmptyLine(body), prefix)].filter(
      (marker): marker is FindingMarkerRecord => marker !== undefined,
    ),
  );
}

function encodeReviewState(state: PriorReviewState): string {
  return Buffer.from(JSON.stringify(state)).toString("base64url");
}

function decodeReviewState(value: string | undefined): PriorReviewState | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return priorReviewStateSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    return undefined;
  }
}

function parsePiprMarker(
  line: string | undefined,
): { name: string; attrs: Record<string, string> } | undefined {
  if (!line) {
    return undefined;
  }
  const match = /^<!--\s*(?<name>pipr:[A-Za-z0-9:_-]+)(?<attrs>.*?)\s*-->$/.exec(line.trim());
  const name = match?.groups?.name;
  if (!name) {
    return undefined;
  }
  return { name, attrs: parseAttrs(match.groups?.attrs ?? "") };
}

function parseAttrs(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const token of input.trim().split(/\s+/)) {
    if (!token) {
      continue;
    }
    const index = token.indexOf("=");
    if (index <= 0) {
      continue;
    }
    attrs[token.slice(0, index)] = token.slice(index + 1);
  }
  return attrs;
}

function hashParts(parts: string[]): string {
  return new Bun.CryptoHasher("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}
