import type {
  FindingActorPermission,
  FindingDropCode,
  FindingOutcomeEvent,
  FindingThreadResolution,
} from "@usepipr/sdk";

/** Finding Outcome events from one ledger, webhook host, or run, with its host's resolution support. */
export type FindingOutcomeSource = {
  /** Absent for local runs, which have no code host threads. */
  threadResolution?: FindingThreadResolution;
  events: readonly FindingOutcomeEvent[];
};

export type FindingStatsGroupBy = "facet" | "agent" | "model" | "config";

/** Terminal outcome of a published finding; see {@link findingOutcomeStats}. */
type TerminalOutcome = "fixed" | "dismissed" | "disputed" | "open";

type FindingOutcomeCounts = {
  /** Distinct findings with any event. */
  findings: number;
  proposed: number;
  /** Proposed findings dropped and never published. */
  dropped: number;
  published: number;
  fixed: number;
  /** Resolved by a human without a fixed verdict. */
  dismissed: number;
  /** Replied to and then judged still valid. */
  disputed: number;
  open: number;
  /** Published findings on hosts that report thread resolution: the dismissal denominator. */
  dismissalEligible: number;
  rates: {
    /** fixed / published */
    fix: number | null;
    /** dismissed / dismissalEligible */
    dismissal: number | null;
    /** fixed / (fixed + dismissed) */
    acceptance: number | null;
    /** dropped / proposed */
    drop: number | null;
  };
};

/** Content-free outcome rates; never carries finding IDs, paths, or bodies. */
export type FindingOutcomeStats = {
  formatVersion: 1;
  totals: FindingOutcomeCounts;
  /** Dropped findings by their last drop reason. */
  dropReasons: Partial<Record<FindingDropCode, number>>;
  /** Replies to findings by the replying actor's repository permission. */
  replyPermissions: Partial<Record<FindingActorPermission, number>>;
  groupBy?: FindingStatsGroupBy;
  /** One group per facet `key=value`, agent, model, or config hash; `(none)` when absent. */
  groups: Array<{ key: string } & FindingOutcomeCounts>;
};

type FindingSummary = {
  findingId: string;
  events: FindingOutcomeEvent[];
  threadResolution: boolean;
  proposed: boolean;
  dropCode?: FindingDropCode;
  published: boolean;
  terminal?: TerminalOutcome;
  stillValid: boolean;
  agent?: string;
  model?: string;
  configHash?: string;
  facets: Record<string, string>;
};

/** Outcomes that only follow publication, so they imply a finding was published. */
const postPublicationKinds = new Set<FindingOutcomeEvent["kind"]>([
  "published",
  "carried",
  "outdated",
  "fixed",
  "still-valid",
  "resolved-by-human",
  "replied",
]);

const noGroup = "(none)";

/**
 * Rates over findings after deduping events by eventId across sources. A published finding's
 * terminal outcome is fixed, else dismissed (resolved by a human), else disputed (a reply followed
 * by a still-valid verdict), else open. Dismissal rates count only findings from hosts that report
 * thread resolution.
 */
export function findingOutcomeStats(
  sources: readonly FindingOutcomeSource[],
  options: { groupBy?: FindingStatsGroupBy } = {},
): FindingOutcomeStats {
  const { findings, events } = summarizeFindings(sources);
  const dropReasons: FindingOutcomeStats["dropReasons"] = {};
  for (const finding of findings) {
    if (finding.dropCode && !finding.published) {
      dropReasons[finding.dropCode] = (dropReasons[finding.dropCode] ?? 0) + 1;
    }
  }
  const replyPermissions: FindingOutcomeStats["replyPermissions"] = {};
  for (const event of events) {
    if (event.kind === "replied" && event.actorPermission) {
      replyPermissions[event.actorPermission] = (replyPermissions[event.actorPermission] ?? 0) + 1;
    }
  }
  const groupBy = options.groupBy;
  return {
    formatVersion: 1,
    totals: countFindings(findings),
    dropReasons: sortedRecord(dropReasons),
    replyPermissions: sortedRecord(replyPermissions),
    ...(groupBy ? { groupBy } : {}),
    groups: groupBy ? groupFindings(findings, groupBy) : [],
  };
}

/** A published finding with a learning label, and the attribution of the run that proposed it. */
export type LabeledFindingOutcome = {
  findingId: string;
  label: "fixed" | "still-valid" | "dismissed";
  /** Execution and Review Run that proposed the finding, or of its earliest event. */
  executionId: string;
  workId: string;
  agent?: string;
  model?: string;
  configHash?: string;
  facets: Record<string, string>;
};

/**
 * Labels for findings whose outcome teaches something: fixed, dismissed (resolved by a human
 * without a fix), or still valid. Findings that stayed open without a verdict are left out.
 */
export function labelFindingOutcomes(
  sources: readonly FindingOutcomeSource[],
): LabeledFindingOutcome[] {
  return summarizeFindings(sources).findings.flatMap((finding) => {
    const label =
      finding.terminal === "fixed" || finding.terminal === "dismissed"
        ? finding.terminal
        : finding.stillValid
          ? "still-valid"
          : undefined;
    const origin =
      finding.events.find((event) => event.kind === "proposed") ??
      (finding.events[0] as FindingOutcomeEvent);
    if (!label) return [];
    return [
      {
        findingId: finding.findingId,
        label,
        executionId: origin.executionId,
        workId: origin.workId,
        ...(finding.agent ? { agent: finding.agent } : {}),
        ...(finding.model ? { model: finding.model } : {}),
        ...(finding.configHash ? { configHash: finding.configHash } : {}),
        facets: finding.facets,
      },
    ];
  });
}

/** Groups webhook `finding_events` rows into sources by their stored thread resolution support. */
export function webhookFindingOutcomeSources(
  records: readonly { threadResolution: FindingThreadResolution; event: FindingOutcomeEvent }[],
): FindingOutcomeSource[] {
  const groups: Record<FindingThreadResolution, FindingOutcomeEvent[]> = {
    available: [],
    unavailable: [],
  };
  for (const record of records) {
    groups[record.threadResolution].push(record.event);
  }
  return (["available", "unavailable"] as const)
    .filter((threadResolution) => groups[threadResolution].length > 0)
    .map((threadResolution) => ({ threadResolution, events: groups[threadResolution] }));
}

function summarizeFindings(sources: readonly FindingOutcomeSource[]): {
  findings: FindingSummary[];
  events: FindingOutcomeEvent[];
} {
  const ordered = dedupeEvents(sources).sort(
    (left, right) =>
      left.event.at.localeCompare(right.event.at) || left.event.sequence - right.event.sequence,
  );
  const byFinding = new Map<string, DedupedEvent[]>();
  for (const entry of ordered) {
    byFinding.set(entry.event.findingId, [...(byFinding.get(entry.event.findingId) ?? []), entry]);
  }
  const findings = [...byFinding.entries()]
    .map(([findingId, entries]) => summarizeFinding(findingId, entries))
    .sort((left, right) => left.findingId.localeCompare(right.findingId));
  return { findings, events: ordered.map((entry) => entry.event) };
}

type DedupedEvent = { event: FindingOutcomeEvent; threadResolution: boolean };

/**
 * One entry per eventId. A reply rebuilt from a host marker records permission `unknown`; the
 * reply run's own event with the real permission wins.
 */
function dedupeEvents(sources: readonly FindingOutcomeSource[]): DedupedEvent[] {
  const byEventId = new Map<string, DedupedEvent>();
  for (const source of sources) {
    const threadResolution = source.threadResolution === "available";
    for (const event of source.events) {
      const existing = byEventId.get(event.eventId);
      byEventId.set(event.eventId, {
        event: existing && !knowsMorePermission(event, existing.event) ? existing.event : event,
        threadResolution: threadResolution || existing?.threadResolution === true,
      });
    }
  }
  return [...byEventId.values()];
}

function knowsMorePermission(event: FindingOutcomeEvent, existing: FindingOutcomeEvent): boolean {
  return existing.actorPermission === "unknown" && event.actorPermission !== "unknown";
}

function summarizeFinding(findingId: string, entries: readonly DedupedEvent[]): FindingSummary {
  const events = entries.map((entry) => entry.event);
  const kinds = new Set(events.map((event) => event.kind));
  const published = events.some((event) => postPublicationKinds.has(event.kind));
  const dropCode = events.findLast((event) => event.kind === "dropped")?.reasonCode;
  const firstReply = events.findIndex((event) => event.kind === "replied");
  const disputed =
    firstReply >= 0 && events.findLastIndex((event) => event.kind === "still-valid") > firstReply;
  const terminal = published ? terminalOutcome(kinds, disputed) : undefined;
  return {
    findingId,
    events,
    threadResolution: entries.some((entry) => entry.threadResolution),
    proposed: kinds.has("proposed"),
    ...(dropCode ? { dropCode } : {}),
    published,
    ...(terminal ? { terminal } : {}),
    stillValid: kinds.has("still-valid"),
    ...attribution(events),
  };
}

function terminalOutcome(
  kinds: ReadonlySet<FindingOutcomeEvent["kind"]>,
  disputed: boolean,
): TerminalOutcome {
  if (kinds.has("fixed")) return "fixed";
  if (kinds.has("resolved-by-human")) return "dismissed";
  return disputed ? "disputed" : "open";
}

/** Attribution from the earliest events that carry it. */
function attribution(
  events: readonly FindingOutcomeEvent[],
): Pick<FindingSummary, "agent" | "model" | "configHash" | "facets"> {
  const agent = events.find((event) => event.agent)?.agent;
  const model = events.find((event) => event.model)?.model;
  const configHash = events.find((event) => event.configHash)?.configHash;
  return {
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(configHash ? { configHash } : {}),
    facets: { ...events.find((event) => Object.keys(event.facets).length > 0)?.facets },
  };
}

function countFindings(findings: readonly FindingSummary[]): FindingOutcomeCounts {
  const count = (predicate: (finding: FindingSummary) => boolean) =>
    findings.filter(predicate).length;
  const terminal = (outcome: TerminalOutcome) => count((finding) => finding.terminal === outcome);
  const proposed = count((finding) => finding.proposed);
  const dropped = count((finding) => finding.dropCode !== undefined && !finding.published);
  const published = count((finding) => finding.published);
  const fixed = terminal("fixed");
  const dismissed = count(
    (finding) => finding.terminal === "dismissed" && finding.threadResolution,
  );
  const dismissalEligible = count((finding) => finding.published && finding.threadResolution);
  return {
    findings: findings.length,
    proposed,
    dropped,
    published,
    fixed,
    dismissed: terminal("dismissed"),
    disputed: terminal("disputed"),
    open: terminal("open"),
    dismissalEligible,
    rates: {
      fix: ratio(fixed, published),
      dismissal: ratio(dismissed, dismissalEligible),
      acceptance: ratio(fixed, fixed + terminal("dismissed")),
      drop: ratio(dropped, proposed),
    },
  };
}

function groupFindings(
  findings: readonly FindingSummary[],
  groupBy: FindingStatsGroupBy,
): FindingOutcomeStats["groups"] {
  const groups = new Map<string, FindingSummary[]>();
  for (const finding of findings) {
    for (const key of groupKeys(finding, groupBy)) {
      groups.set(key, [...(groups.get(key) ?? []), finding]);
    }
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, members]) => ({ key, ...countFindings(members) }));
}

function groupKeys(finding: FindingSummary, groupBy: FindingStatsGroupBy): string[] {
  if (groupBy === "facet") {
    const facets = Object.entries(finding.facets).map(([key, value]) => `${key}=${value}`);
    return facets.length > 0 ? facets : [noGroup];
  }
  const value =
    groupBy === "agent" ? finding.agent : groupBy === "model" ? finding.model : finding.configHash;
  return [value ?? noGroup];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function sortedRecord<T extends string>(record: Partial<Record<T, number>>) {
  return Object.fromEntries(
    Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
  ) as Partial<Record<T, number>>;
}
