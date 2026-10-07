import type { FindingThreadResolution } from "@usepipr/sdk";
import { findingHistoryCodes, findingHistoryHeadLength } from "../publication/schemas.js";
import type { PriorReviewState } from "../publication/types.js";
import {
  applyInlineFindingMarkers,
  applyResolvedFindingMarkers,
  extractInlineFindingMarkerRecords,
  extractResolvedFindingMarkerRecords,
  extractStillValidReplyMarkers,
  parseInlineFindingMarker,
} from "./comment-markers.js";
import { type FindingOutcomeEmission, findingOutcomeAnchors } from "./finding-ledger.js";
import {
  applyNativeThreadResolutions,
  findingHistoryHas,
  priorFindingAttribution,
  recordFindingOutcomeHistory,
} from "./prior-state.js";

/** Prior review state read back from a change request's Pipr comments. */
export type LoadedPriorReviewState = {
  state: PriorReviewState;
  /** Whether the host reports native thread resolution, so `resolved-by-human` is observable. */
  threadResolution: FindingThreadResolution;
  /**
   * Outcomes observed on the host that `state` did not record yet: Pipr resolutions and verifier
   * replies posted by reply runs, and threads a human resolved. `state` history already notes them.
   */
  events: FindingOutcomeEmission[];
};

/** Owned inline comment as loaded from the host. */
type LoadedInlineComment = { body: string; resolved?: boolean };

/**
 * Reconciles stored review state with the host's comments: inline markers set where each finding
 * was last commented, unconfirmed `published` history is dropped, Pipr and native resolutions set
 * the status, and outcomes the state has not recorded yet become events.
 */
export function reconcilePriorReviewState(options: {
  prior: PriorReviewState;
  inline: readonly LoadedInlineComment[];
  /** Bodies of replies in owned inline threads. */
  replyBodies: readonly string[];
  threadResolution: FindingThreadResolution;
}): LoadedPriorReviewState {
  const inlineBodies = options.inline.map((item) => item.body);
  const bodies = [...inlineBodies, ...options.replyBodies];
  const nativeResolutions =
    options.threadResolution === "available" ? nativeThreadResolutions(options.inline) : [];
  const reconciled = applyNativeThreadResolutions(
    applyResolvedFindingMarkers(
      withConfirmedPublications(applyInlineFindingMarkers(options.prior, bodies), inlineBodies),
      bodies,
    ),
    nativeResolutions,
  );
  const observed = observedOutcomes(reconciled, bodies, nativeResolutions);
  return {
    state: recordFindingOutcomeHistory(
      reconciled,
      observed.map(({ emission, headSha }) => ({
        findingId: emission.findingId,
        kind: emission.kind,
        headSha,
      })),
    ),
    threadResolution: options.threadResolution,
    events: observed.map(({ emission }) => emission),
  };
}

type NativeResolution = { findingId: string; findingHeadSha: string; resolved: boolean };

function nativeThreadResolutions(inline: readonly LoadedInlineComment[]): NativeResolution[] {
  return inline.flatMap(({ body, resolved }) => {
    const marker = resolved === undefined ? undefined : parseInlineFindingMarker(body);
    return marker && resolved !== undefined
      ? [{ findingId: marker.id, findingHeadSha: marker.head, resolved }]
      : [];
  });
}

/** Keeps `published` history only where an inline comment marker confirms the post. */
function withConfirmedPublications(
  state: PriorReviewState,
  inlineBodies: readonly string[],
): PriorReviewState {
  const posted = new Set(
    extractInlineFindingMarkerRecords([...inlineBodies]).map(
      (record) => `${record.id}:${record.head.slice(0, findingHistoryHeadLength)}`,
    ),
  );
  return {
    ...state,
    findings: state.findings.map((record) => {
      if (!record.h) return record;
      const { h, ...rest } = record;
      const history = h.filter(
        ([code, head]) =>
          code !== findingHistoryCodes.published || posted.has(`${record.id}:${head}`),
      );
      return history.length > 0 ? { ...rest, h: history } : rest;
    }),
  };
}

type ObservedOutcome = { emission: FindingOutcomeEmission; headSha: string };

/** Outcomes one host marker shows, and the history entry that means they were recorded. */
type MarkerOutcomes = {
  findingId: string;
  headSha: string;
  recorded: { kind: "fixed" | "still-valid" | "resolved-by-human"; headSha?: string };
  emissions: Omit<FindingOutcomeEmission, "findingId" | "attribution">[];
};

/**
 * Outcomes shown by host markers that the stored history has not recorded yet, once per finding
 * and kind, attributed from the stored finding.
 */
function observedOutcomes(
  state: PriorReviewState,
  bodies: readonly string[],
  nativeResolutions: readonly NativeResolution[],
): ObservedOutcome[] {
  const records = new Map(state.findings.map((record) => [record.id, record]));
  const piprResolutions = extractResolvedFindingMarkerRecords([...bodies]);
  const candidates: MarkerOutcomes[] = [
    ...piprResolutions.map((marker) => ({
      findingId: marker.id,
      headSha: marker.head,
      recorded: { kind: "fixed" as const },
      emissions: [
        { kind: "fixed" as const, anchor: findingOutcomeAnchors.piprResolution(marker.head) },
      ],
    })),
    ...extractStillValidReplyMarkers(bodies).map((marker) => {
      const headSha = records.get(marker.id)?.lastCommentedHeadSha ?? state.reviewedHeadSha;
      return {
        findingId: marker.id,
        headSha,
        recorded: { kind: "still-valid" as const, headSha },
        emissions: [
          {
            kind: "replied" as const,
            actorPermission: "unknown" as const,
            anchor: findingOutcomeAnchors.reply(marker.threadKey, marker.replyCommentId),
          },
          {
            kind: "still-valid" as const,
            anchor: findingOutcomeAnchors.verifierResponse(marker.responseKey),
          },
        ],
      };
    }),
    ...humanResolutions(nativeResolutions, piprResolutions),
  ];
  const observed = new Set<string>();
  return candidates.flatMap((candidate) => {
    const record = records.get(candidate.findingId);
    const key = `${candidate.findingId}:${candidate.recorded.kind}`;
    if (
      !record ||
      observed.has(key) ||
      findingHistoryHas(record, candidate.recorded.kind, candidate.recorded.headSha)
    ) {
      return [];
    }
    observed.add(key);
    const attribution = priorFindingAttribution(record);
    return candidate.emissions.map((emission) => ({
      emission: { ...emission, findingId: record.id, ...(attribution ? { attribution } : {}) },
      headSha: candidate.headSha,
    }));
  });
}

/** Natively resolved threads without a Pipr resolution marker for the same finding and head. */
function humanResolutions(
  nativeResolutions: readonly NativeResolution[],
  piprResolutions: readonly { id: string; head: string }[],
): MarkerOutcomes[] {
  const piprResolved = new Set(piprResolutions.map((marker) => `${marker.id}:${marker.head}`));
  return nativeResolutions.flatMap((resolution) =>
    resolution.resolved && !piprResolved.has(`${resolution.findingId}:${resolution.findingHeadSha}`)
      ? [
          {
            findingId: resolution.findingId,
            headSha: resolution.findingHeadSha,
            recorded: { kind: "resolved-by-human" as const },
            emissions: [
              {
                kind: "resolved-by-human" as const,
                anchor: findingOutcomeAnchors.humanResolution(resolution.findingHeadSha),
              },
            ],
          },
        ]
      : [],
  );
}
