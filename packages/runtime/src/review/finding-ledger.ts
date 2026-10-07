import { createHash } from "node:crypto";
import type {
  DiagnosticFindingLedger,
  FindingActorPermission,
  FindingDropCode,
  FindingEvidence,
  FindingOutcomeEvent,
  FindingOutcomeKind,
  ReviewFinding,
} from "@usepipr/sdk";
import type { PriorReviewState } from "../publication/types.js";
import type { ChangeRequestEventContext } from "../types.js";
import { findingIdFor, matchFindingRecord } from "./prior-state.js";
import type { PlannedFindingDisposition } from "./publication-plan.js";
import type { VerifierVerdict } from "./verifier.js";

/** Out-of-band facts about a finding; never added to the finding objects users see. */
export type FindingAttribution = {
  agent?: string;
  model?: string;
  facets: Record<string, string>;
};

/** The Review Run an outcome belongs to. */
export type FindingLedgerContext = {
  workId: string;
  baseSha: string;
  headSha: string;
  configHash?: string;
};

/** Identifies the Review Run in Finding Outcome events. */
export function findingLedgerContext(
  options: { event: ChangeRequestEventContext; trustedConfigHash?: string },
  run: { id: string },
): FindingLedgerContext {
  return {
    workId: run.id,
    baseSha: options.event.change.base.sha,
    headSha: options.event.change.head.sha,
    ...(options.trustedConfigHash ? { configHash: options.trustedConfigHash } : {}),
  };
}

/** One outcome before the ledger stamps identity, order, and time on it. */
export type FindingOutcomeEmission = {
  kind: FindingOutcomeKind;
  findingId: string;
  reasonCode?: FindingDropCode;
  actorPermission?: FindingActorPermission;
  attribution?: FindingAttribution;
  /** Diagnostic location and content; kept out of public events. */
  finding?: ReviewFinding;
};

type AttributedFinding = { finding: ReviewFinding; attribution: FindingAttribution };

/**
 * Derives outcomes decided by one review run: every validated finding is proposed; validation,
 * selection, and publication planning drop some; re-found prior findings are carried, prior open
 * findings not re-found are outdated, and verifier verdicts mark prior findings fixed or still
 * valid. Published outcomes follow publication through {@link FindingLedger.recordPublished}.
 *
 * Valid findings use the IDs publication planning assigned; dropped findings get the ID
 * publication would have assigned against the prior review state.
 */
export function deriveReviewFindingOutcomes(input: {
  /** Findings that passed final validation, in `validFindings` order. */
  valid: readonly AttributedFinding[];
  /** Publication planning dispositions aligned with `valid`. */
  dispositions: readonly PlannedFindingDisposition[];
  dropped: readonly (AttributedFinding & { code: FindingDropCode })[];
  /** Prior review state scoped to the selected tasks, before the verifier resolved anything. */
  priorReviewState?: PriorReviewState;
  verdicts: readonly VerifierVerdict[];
}): FindingOutcomeEmission[] {
  const prior = input.priorReviewState;
  const validIds = input.valid.map(
    (item, index) => dispositionFindingId(input.dispositions[index]) ?? findingIdFor(item.finding),
  );
  const reserved = new Set(validIds);
  const droppedIds = input.dropped.map((item) => {
    const matched = prior ? matchFindingRecord(prior, item.finding) : undefined;
    return matched && !reserved.has(matched.id) ? matched.id : findingIdFor(item.finding);
  });
  const emissions: FindingOutcomeEmission[] = [
    ...input.valid.map((item, index) => emission("proposed", validIds[index], item)),
    ...input.dropped.map((item, index) => emission("proposed", droppedIds[index], item)),
    ...input.dropped.map((item, index) => ({
      ...emission("dropped", droppedIds[index], item),
      reasonCode: item.code,
    })),
  ];
  const priorIds = new Set(prior?.findings.map((record) => record.id) ?? []);
  for (const [index, item] of input.valid.entries()) {
    const disposition = input.dispositions[index];
    const findingId = validIds[index] as string;
    if (disposition?.kind === "dropped") {
      emissions.push({ ...emission("dropped", findingId, item), reasonCode: disposition.code });
    } else if (disposition?.kind === "carried" || priorIds.has(findingId)) {
      emissions.push(emission("carried", findingId, item));
    }
  }
  const reported = new Set([...validIds, ...droppedIds]);
  const judged = new Set(input.verdicts.map((verdict) => verdict.findingId));
  for (const record of prior?.findings ?? []) {
    if (record.status === "open" && !reported.has(record.id) && !judged.has(record.id)) {
      emissions.push({ kind: "outdated", findingId: record.id });
    }
  }
  for (const verdict of input.verdicts) {
    emissions.push({ kind: verdict.status, findingId: verdict.findingId });
  }
  return emissions;
}

function dispositionFindingId(
  disposition: PlannedFindingDisposition | undefined,
): string | undefined {
  return disposition && "findingId" in disposition ? disposition.findingId : undefined;
}

function emission(
  kind: FindingOutcomeKind,
  findingId: string | undefined,
  item: AttributedFinding,
): FindingOutcomeEmission {
  if (!findingId) throw new Error("finding outcome requires a finding id");
  return { kind, findingId, attribution: item.attribution, finding: item.finding };
}

/** Append-only Finding Outcome events of one execution, with diagnostic evidence per finding. */
export type FindingLedger = {
  readonly executionId: string;
  record(context: FindingLedgerContext, emissions: readonly FindingOutcomeEmission[]): void;
  /** Records `published` for the inline comments a host actually posted. */
  recordPublished(context: FindingLedgerContext, findingIds: readonly string[]): void;
  /** Public, content-free events in emission order. */
  events(): FindingOutcomeEvent[];
  /** Events plus diagnostic evidence for the `ledger` Run Bundle artifact. */
  document(): DiagnosticFindingLedger;
};

export function createFindingLedger(options: {
  executionId: string;
  now?: () => Date;
}): FindingLedger {
  const now = options.now ?? (() => new Date());
  const events: FindingOutcomeEvent[] = [];
  const eventIds = new Set<string>();
  const attributions = new Map<string, FindingAttribution>();
  const evidence: Record<string, FindingEvidence> = {};

  const record = (context: FindingLedgerContext, emissions: readonly FindingOutcomeEmission[]) => {
    for (const item of emissions) {
      if (item.attribution && !attributions.has(item.findingId)) {
        attributions.set(item.findingId, item.attribution);
      }
      if (item.finding && !evidence[item.findingId]) {
        evidence[item.findingId] = findingEvidence(item.finding, context);
      }
      const eventId = findingOutcomeEventId(item, context);
      if (eventIds.has(eventId)) continue;
      eventIds.add(eventId);
      events.push(outcomeEvent(item, context, attributions.get(item.findingId), eventId));
    }
  };

  const outcomeEvent = (
    item: FindingOutcomeEmission,
    context: FindingLedgerContext,
    attribution: FindingAttribution | undefined,
    eventId: string,
  ): FindingOutcomeEvent => ({
    eventId,
    findingId: item.findingId,
    kind: item.kind,
    ...(item.reasonCode ? { reasonCode: item.reasonCode } : {}),
    ...(item.actorPermission ? { actorPermission: item.actorPermission } : {}),
    workId: context.workId,
    executionId: options.executionId,
    headSha: context.headSha,
    ...(context.configHash ? { configHash: context.configHash } : {}),
    ...(attribution?.agent ? { agent: attribution.agent } : {}),
    ...(attribution?.model ? { model: attribution.model } : {}),
    facets: { ...attribution?.facets },
    at: now().toISOString(),
    sequence: events.length,
  });

  return {
    executionId: options.executionId,
    record,
    recordPublished(context, findingIds) {
      record(
        context,
        findingIds.map((findingId) => ({ kind: "published", findingId })),
      );
    },
    events: () => events.map((event) => ({ ...event, facets: { ...event.facets } })),
    document: () => ({
      formatVersion: 1,
      events: events.map((event) => ({ ...event, facets: { ...event.facets } })),
      evidence: { ...evidence },
    }),
  };
}

/** sha256 of `findingId|kind|headSha|workId|reasonCode`, so reruns of the same work dedupe. */
function findingOutcomeEventId(item: FindingOutcomeEmission, context: FindingLedgerContext) {
  return createHash("sha256")
    .update(
      [item.findingId, item.kind, context.headSha, context.workId, item.reasonCode ?? ""].join("|"),
    )
    .digest("hex");
}

function findingEvidence(finding: ReviewFinding, context: FindingLedgerContext): FindingEvidence {
  return {
    path: finding.path,
    rangeId: finding.rangeId,
    side: finding.side,
    startLine: finding.startLine,
    endLine: finding.endLine,
    body: finding.body,
    ...(finding.suggestedFix === undefined ? {} : { suggestedFix: finding.suggestedFix }),
    baseSha: context.baseSha,
    headSha: context.headSha,
  };
}
