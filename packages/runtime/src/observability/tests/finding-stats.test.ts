import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import type { FindingOutcomeEvent, FindingOutcomeKind } from "@usepipr/sdk";
import {
  type FindingOutcomeSource,
  findingOutcomeStats,
  labelFindingOutcomes,
  webhookFindingOutcomeSources,
} from "../finding-stats.js";

let sequence = 0;

function outcome(
  findingId: string,
  kind: FindingOutcomeKind,
  overrides: Partial<FindingOutcomeEvent> = {},
): FindingOutcomeEvent {
  sequence += 1;
  return {
    eventId: createHash("sha256").update(`${findingId}|${kind}|${sequence}`).digest("hex"),
    findingId,
    kind,
    ...(kind === "dropped" ? { reasonCode: "cap" as const } : {}),
    ...(kind === "replied" ? { actorPermission: "write" as const } : {}),
    workId: "work_1",
    executionId: "0123456789abcdef0123456789abcdef",
    headSha: "a".repeat(40),
    configHash: "c".repeat(64),
    agent: "reviewer",
    model: "deepseek-reasoner",
    facets: { severity: "high" },
    at: new Date(Date.UTC(2026, 9, 1, 0, 0, sequence)).toISOString(),
    sequence,
    ...overrides,
  };
}

function published(findingId: string, ...later: FindingOutcomeKind[]): FindingOutcomeEvent[] {
  return [
    outcome(findingId, "proposed"),
    outcome(findingId, "published"),
    ...later.map((kind) => outcome(findingId, kind)),
  ];
}

const available = (events: FindingOutcomeEvent[]): FindingOutcomeSource => ({
  threadResolution: "available",
  events,
});

describe("finding outcome stats", () => {
  it("resolves one terminal outcome per finding with fixed > dismissed > disputed > open", () => {
    const stats = findingOutcomeStats([
      available([
        ...published("fnd_fixed", "resolved-by-human", "fixed"),
        ...published("fnd_dismissed", "replied", "still-valid", "resolved-by-human"),
        ...published("fnd_disputed", "replied", "still-valid"),
        ...published("fnd_still_valid", "still-valid", "replied"),
        ...published("fnd_open"),
      ]),
    ]);

    expect(stats.totals).toMatchObject({
      findings: 5,
      published: 5,
      fixed: 1,
      dismissed: 1,
      disputed: 1,
      open: 2,
    });
  });

  it("computes fix, dismissal, acceptance, and drop rates", () => {
    const stats = findingOutcomeStats([
      available([
        ...published("fnd_a", "fixed"),
        ...published("fnd_b", "fixed"),
        ...published("fnd_c", "resolved-by-human"),
        ...published("fnd_d"),
        outcome("fnd_e", "proposed"),
        outcome("fnd_e", "dropped", { reasonCode: "out-of-range" }),
        outcome("fnd_f", "proposed"),
        outcome("fnd_f", "dropped", { reasonCode: "cap" }),
        outcome("fnd_g", "proposed"),
        outcome("fnd_g", "dropped", { reasonCode: "cap" }),
      ]),
    ]);

    expect(stats.totals).toMatchObject({ proposed: 7, dropped: 3, published: 4 });
    expect(stats.totals.rates).toEqual({
      fix: 0.5,
      dismissal: 0.25,
      acceptance: 2 / 3,
      drop: 3 / 7,
    });
    expect(stats.dropReasons).toEqual({ cap: 2, "out-of-range": 1 });
  });

  it("leaves findings from hosts without thread resolution out of dismissal rates", () => {
    const stats = findingOutcomeStats([
      available([...published("fnd_a", "resolved-by-human"), ...published("fnd_b")]),
      { threadResolution: "unavailable", events: [...published("fnd_c"), ...published("fnd_d")] },
      { events: published("fnd_local") },
    ]);

    expect(stats.totals).toMatchObject({ published: 5, dismissed: 1, dismissalEligible: 2 });
    expect(stats.totals.rates.dismissal).toBe(0.5);
    expect(stats.totals.rates.fix).toBe(0);
  });

  it("reports rates without a denominator as null", () => {
    expect(findingOutcomeStats([]).totals.rates).toEqual({
      fix: null,
      dismissal: null,
      acceptance: null,
      drop: null,
    });
  });

  it("counts findings published before the selected events as published", () => {
    const stats = findingOutcomeStats([available([outcome("fnd_old", "fixed")])]);

    expect(stats.totals).toMatchObject({ published: 1, fixed: 1, proposed: 0 });
  });

  it("dedupes events by eventId across sources and keeps the real reply permission", () => {
    const events = published("fnd_a", "replied", "still-valid");
    const reply = events[2] as FindingOutcomeEvent;
    const rebuilt = { ...reply, actorPermission: "unknown" as const, sequence: 99 };
    const stats = findingOutcomeStats([
      { threadResolution: "available", events: [rebuilt] },
      available(events),
      available(events),
    ]);

    expect(stats.totals).toMatchObject({ findings: 1, proposed: 1, published: 1, disputed: 1 });
    expect(stats.replyPermissions).toEqual({ write: 1 });
  });

  it("groups by facet value, agent, model, and config hash", () => {
    const sources = [
      available([
        ...published("fnd_a", "fixed"),
        outcome("fnd_b", "proposed", {
          agent: "security",
          model: "gpt-test",
          configHash: "d".repeat(64),
          facets: { severity: "low", category: "security" },
        }),
        outcome("fnd_b", "published", { agent: "security", facets: {} }),
        outcome("fnd_c", "proposed", { facets: {} }),
      ]),
    ];

    expect(
      findingOutcomeStats(sources, { groupBy: "facet" }).groups.map((group) => [
        group.key,
        group.findings,
        group.fixed,
      ]),
    ).toEqual([
      ["(none)", 1, 0],
      ["category=security", 1, 0],
      ["severity=high", 1, 1],
      ["severity=low", 1, 0],
    ]);
    expect(
      findingOutcomeStats(sources, { groupBy: "agent" }).groups.map((group) => group.key),
    ).toEqual(["reviewer", "security"]);
    expect(
      findingOutcomeStats(sources, { groupBy: "model" }).groups.map((group) => group.key),
    ).toEqual(["deepseek-reasoner", "gpt-test"]);
    expect(
      findingOutcomeStats(sources, { groupBy: "config" }).groups.map((group) => [
        group.key,
        group.findings,
      ]),
    ).toEqual([
      ["c".repeat(64), 2],
      ["d".repeat(64), 1],
    ]);
    expect(findingOutcomeStats(sources).groups).toEqual([]);
  });

  it("never reports finding IDs, paths, or bodies", () => {
    const stats = JSON.stringify(
      findingOutcomeStats([available(published("fnd_secret_id", "fixed"))], { groupBy: "agent" }),
    );

    expect(stats).not.toContain("fnd_secret_id");
    expect(stats).not.toContain("0123456789abcdef0123456789abcdef");
  });
});

describe("finding outcome labels", () => {
  it("labels fixed, still-valid, and dismissed findings and skips the rest", () => {
    const labels = labelFindingOutcomes([
      available([
        ...published("fnd_fixed", "still-valid", "fixed"),
        ...published("fnd_valid", "still-valid"),
        ...published("fnd_dismissed", "resolved-by-human"),
        ...published("fnd_open"),
        outcome("fnd_dropped", "dropped"),
      ]),
    ]);

    expect(labels.map(({ findingId, label }) => [findingId, label])).toEqual([
      ["fnd_dismissed", "dismissed"],
      ["fnd_fixed", "fixed"],
      ["fnd_valid", "still-valid"],
    ]);
    expect(labels[1]).toMatchObject({
      agent: "reviewer",
      model: "deepseek-reasoner",
      configHash: "c".repeat(64),
      facets: { severity: "high" },
    });
  });
});

describe("webhook finding outcome sources", () => {
  it("derives thread resolution support from each row's host", () => {
    const record = (host: string, findingId: string) => ({
      host,
      repository: "acme/app",
      deliveryId: "delivery",
      event: outcome(findingId, "published"),
    });
    const sources = webhookFindingOutcomeSources([
      record("github", "fnd_a"),
      record("gitea", "fnd_b"),
      record("gitlab", "fnd_c"),
      record("codeberg", "fnd_d"),
    ]);

    expect(
      sources.map((source) => [source.threadResolution, source.events.map((e) => e.findingId)]),
    ).toEqual([
      ["available", ["fnd_a", "fnd_c"]],
      ["unavailable", ["fnd_b", "fnd_d"]],
    ]);
  });
});
