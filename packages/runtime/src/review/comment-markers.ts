import { Buffer } from "node:buffer";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { defaultMaxStoredFindings } from "@usepipr/sdk/internal";
import { firstNonEmptyLine } from "../commands/grammar.js";
import {
  findingIdSchema,
  oldestTrimmableHistoryIndex,
  priorReviewStateSchema,
} from "../publication/schemas.js";
import type { PriorFindingRecord, PriorReviewState } from "../publication/types.js";

export const mainCommentMarker = "pipr:main-comment";
const inlineFindingMarkerPrefix = "pipr:finding";
const resolvedFindingMarkerPrefix = "pipr:resolved";
const verifierResponseMarkerPrefix = "pipr:verifier-response";

type FindingMarkerRecord = {
  id: string;
  head: string;
  marker: string;
};

/**
 * Largest encoded review state the main comment marker carries. The smallest host comment limit
 * is Bitbucket Data Center's 32 KiB (GitHub allows 65,536 characters, GitLab 1,000,000, Gitea and
 * Forgejo store LONGTEXT), and the rendered review keeps at least 8 KiB beside the state there.
 */
const maxEncodedReviewStateLength = 24_000;

export function renderMainCommentMarker(options: {
  marker: string;
  changeNumber: number;
  reviewState: PriorReviewState;
  maxStoredFindings?: number;
}): string {
  const state = encodeReviewStateWithinBudget({
    ...options.reviewState,
    findings: options.reviewState.findings.slice(
      0,
      options.maxStoredFindings ?? defaultMaxStoredFindings,
    ),
  });
  return `<!-- ${options.marker} change=${options.changeNumber} version=1 state=${state} -->`;
}

/**
 * Encodes the state, trimming it until it fits {@link maxEncodedReviewStateLength}: first the
 * oldest history entry of every finding per pass, then resolved or historical findings, then
 * open findings, each oldest first (findings are stored newest first), then the oldest workflow
 * URLs.
 */
function encodeReviewStateWithinBudget(state: PriorReviewState): string {
  let current = state;
  let encoded = encodeReviewState(current);
  for (const trim of reviewStateTrimSteps) {
    let next = encoded.length > maxEncodedReviewStateLength ? trim(current) : undefined;
    while (next) {
      current = next;
      encoded = encodeReviewState(current);
      next = encoded.length > maxEncodedReviewStateLength ? trim(current) : undefined;
    }
  }
  return encoded;
}

/** Each step trims a little more, or returns undefined when it has nothing left to trim. */
const reviewStateTrimSteps: ReadonlyArray<
  (state: PriorReviewState) => PriorReviewState | undefined
> = [
  (state) =>
    state.findings.some((finding) => finding.h)
      ? { ...state, findings: state.findings.map(withoutOldestHistoryEntry) }
      : undefined,
  (state) =>
    withoutOldestFinding(
      state,
      (finding) => finding.status !== "open" || finding.lastSeenHeadSha !== state.reviewedHeadSha,
    ),
  (state) => withoutOldestFinding(state, () => true),
  (state) => {
    if (!state.workflowUrls?.length) return undefined;
    const {
      workflowUrls: [, ...workflowUrls],
      ...rest
    } = state;
    return workflowUrls.length > 0 ? { ...rest, workflowUrls } : rest;
  },
];

function withoutOldestHistoryEntry(finding: PriorFindingRecord): PriorFindingRecord {
  if (!finding.h) return finding;
  const { h, ...rest } = finding;
  const history = h.toSpliced(oldestTrimmableHistoryIndex(h), 1);
  return history.length > 0 ? { ...rest, h: history } : rest;
}

function withoutOldestFinding(
  state: PriorReviewState,
  trimmable: (finding: PriorFindingRecord) => boolean,
): PriorReviewState | undefined {
  const index = state.findings.findLastIndex(trimmable);
  return index === -1 ? undefined : { ...state, findings: state.findings.toSpliced(index, 1) };
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

export function parseInlineFindingMarker(body: string): FindingMarkerRecord | undefined {
  return parseFindingHeadMarker(firstNonEmptyLine(body), inlineFindingMarkerPrefix);
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

/** Verifier replies that told a human their finding still applies: finding ID, key, reply ID. */
export function extractStillValidReplyMarkers(
  commentBodies: readonly string[],
): Array<{ id: string; responseKey: string; replyCommentId: string }> {
  return extractMarkerRecords([...commentBodies], verifierResponseMarkerPrefix).flatMap(
    (record) => {
      const replyCommentId = /^reply-(?<comment>[^:]+):still-valid:/.exec(record.head)?.groups
        ?.comment;
      return replyCommentId ? [{ id: record.id, responseKey: record.head, replyCommentId }] : [];
    },
  );
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
  const markerById = new Map(
    extractInlineFindingMarkerRecords(commentBodies).map((record) => [record.id, record.head]),
  );
  return {
    ...state,
    findings: state.findings.map((finding) => {
      const headSha = markerById.get(finding.id);
      const { lastCommentedHeadSha: _lastCommentedHeadSha, ...rest } = finding;
      return headSha ? { ...rest, lastCommentedHeadSha: headSha } : rest;
    }),
  };
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
  return { id, head, marker: `${prefix}:${id}:${head}` };
}

function extractMarkerRecords(commentBodies: string[], prefix: string): FindingMarkerRecord[] {
  return commentBodies.flatMap(
    (body) => parseFindingHeadMarker(firstNonEmptyLine(body), prefix) ?? [],
  );
}

/** Review state is raw-deflated JSON in base64url. */
function encodeReviewState(state: PriorReviewState): string {
  return deflateRawSync(JSON.stringify(state)).toString("base64url");
}

/** Bounds inflation of a hostile marker; real state stays far below this. */
const maxDecodedReviewStateBytes = 1024 * 1024;

function decodeReviewState(value: string | undefined): PriorReviewState | undefined {
  if (!value || value.length > maxEncodedReviewStateLength) {
    return undefined;
  }
  try {
    const json = inflateRawSync(Buffer.from(value, "base64url"), {
      maxOutputLength: maxDecodedReviewStateBytes,
    }).toString("utf8");
    return priorReviewStateSchema.parse(JSON.parse(json));
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
