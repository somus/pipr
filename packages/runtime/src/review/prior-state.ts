import { Buffer } from "node:buffer";
import { z } from "zod";
import { firstNonEmptyLine } from "../commands/grammar.js";
import type { ReviewFinding } from "../types.js";
import { reviewSideSchema } from "../types.js";

export const mainCommentMarker = "pipr:main-comment";
const inlineFindingMarkerPrefix = "pipr:finding";
const resolvedFindingMarkerPrefix = "pipr:resolved";
const verifierResponseMarkerPrefix = "pipr:verifier-response";
const maxStoredFindings = 100;

export const findingIdSchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_.-]+$/);

const priorFindingStatusSchema = z.enum(["open", "resolved"]);

const priorFindingRecordSchema = z.strictObject({
  id: findingIdSchema,
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
});

export type PriorFindingRecord = z.infer<typeof priorFindingRecordSchema>;
export type PriorReviewState = z.infer<typeof priorReviewStateSchema>;
export type FindingMarkerRecord = {
  id: string;
  head: string;
  marker: string;
};

export function buildPriorReviewState(options: {
  priorState?: PriorReviewState;
  findings: ReviewFinding[];
  reviewedHeadSha: string;
  selectedTasks: string[];
}): { state: PriorReviewState } {
  const scopedPriorState = priorReviewStateForSelectedTasks(
    options.priorState,
    options.selectedTasks,
  );
  const priorFindings = new Map(
    (scopedPriorState?.findings ?? []).map((finding) => [finding.id, finding]),
  );
  const nextFindings = new Map<string, PriorFindingRecord>();
  const currentFindingIds = new Set<string>();
  const usedPriorIds = new Set<string>();

  for (const finding of options.findings) {
    const id = selectFindingId({
      finding,
      findings: options.findings,
      priorFindings,
      usedPriorIds,
    });
    const prior = priorFindings.get(id);
    if (prior) {
      usedPriorIds.add(prior.id);
    }
    currentFindingIds.add(id);
    nextFindings.set(
      id,
      priorFindingRecordSchema.parse({
        id,
        status: "open",
        path: finding.path,
        rangeId: finding.rangeId,
        side: finding.side,
        startLine: finding.startLine,
        endLine: finding.endLine,
        firstSeenHeadSha: prior?.firstSeenHeadSha ?? options.reviewedHeadSha,
        lastSeenHeadSha: options.reviewedHeadSha,
        lastCommentedHeadSha: prior?.lastCommentedHeadSha,
      }),
    );
  }

  for (const prior of priorFindings.values()) {
    if (nextFindings.has(prior.id)) {
      continue;
    }
    nextFindings.set(prior.id, priorFindingRecordSchema.parse(prior));
  }

  return {
    state: priorReviewStateSchema.parse({
      version: 1,
      reviewedHeadSha: options.reviewedHeadSha,
      selectedTasks: options.selectedTasks,
      findings: cappedFindings([...nextFindings.values()], currentFindingIds),
    }),
  };
}

export function resolvePriorFindings(
  state: PriorReviewState,
  findingIds: Iterable<string>,
): PriorReviewState {
  const resolved = new Set(findingIds);
  return priorReviewStateSchema.parse({
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      status: resolved.has(finding.id) ? "resolved" : finding.status,
    })),
  });
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

export function renderMainCommentMarker(options: {
  marker: string;
  changeNumber: number;
  reviewState: PriorReviewState;
}): string {
  return `<!-- ${options.marker} change=${options.changeNumber} version=1 state=${encodeReviewState(
    options.reviewState,
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
  return commentBodies.flatMap((body) =>
    [parseFindingHeadMarker(firstNonEmptyLine(body), inlineFindingMarkerPrefix)].filter(
      (marker): marker is FindingMarkerRecord => marker !== undefined,
    ),
  );
}

export function extractInlineFindingMarkers(commentBodies: string[]): Set<string> {
  return new Set(extractInlineFindingMarkerRecords(commentBodies).map((record) => record.marker));
}

export function extractResolvedFindingMarkerRecords(
  commentBodies: string[],
): FindingMarkerRecord[] {
  return commentBodies.flatMap((body) =>
    [parseFindingHeadMarker(firstNonEmptyLine(body), resolvedFindingMarkerPrefix)].filter(
      (marker): marker is FindingMarkerRecord => marker !== undefined,
    ),
  );
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
  return priorReviewStateSchema.parse({
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      status:
        finding.lastCommentedHeadSha &&
        resolvedMarkers.has(`${finding.id}:${finding.lastCommentedHeadSha}`)
          ? "resolved"
          : finding.status,
    })),
  });
}

export function extractVerifierResponseMarkers(commentBodies: string[]): Set<string> {
  return new Set(
    commentBodies
      .flatMap((body) =>
        [parseFindingHeadMarker(firstNonEmptyLine(body), verifierResponseMarkerPrefix)].filter(
          (marker): marker is FindingMarkerRecord => marker !== undefined,
        ),
      )
      .map((record) => record.marker),
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
  return priorReviewStateSchema.parse({
    ...state,
    findings: state.findings.map((finding) => ({
      ...finding,
      lastCommentedHeadSha: markerById.get(finding.id),
    })),
  });
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

function cappedFindings(
  findings: PriorFindingRecord[],
  currentFindingIds: Set<string>,
): PriorFindingRecord[] {
  const current = findings.filter((finding) => currentFindingIds.has(finding.id));
  const historical = findings
    .filter((finding) => !currentFindingIds.has(finding.id))
    .slice(0, Math.max(0, maxStoredFindings - current.length));
  return [...current, ...historical];
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

function encodeReviewState(state: PriorReviewState): string {
  return Buffer.from(JSON.stringify(priorReviewStateSchema.parse(state))).toString("base64url");
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
