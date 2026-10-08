import { describe, expect, it } from "bun:test";
import {
  diagnosticFindingLedgerSchema,
  type FindingDatasetCase,
  type FindingOutcomeEvent,
  findingDatasetCaseSchema,
  findingLedgerSchema,
  findingOutcomeEventSchema,
} from "../index.js";
import { normalizeFindingAttribution } from "../internal.js";

const event: FindingOutcomeEvent = {
  eventId: "a".repeat(64),
  findingId: "fnd_0123456789abcdef",
  kind: "dropped",
  reasonCode: "cap",
  workId: "run_1",
  executionId: "0123456789abcdef0123456789abcdef",
  headSha: "b".repeat(40),
  configHash: "c".repeat(64),
  agent: "security-reviewer",
  model: "deepseek-reasoner",
  facets: { severity: "high" },
  at: "2026-10-07T00:00:00.000Z",
  sequence: 0,
};

describe("Finding Outcome events", () => {
  it("accepts content-free events and requires reason codes only on drops", () => {
    expect(findingOutcomeEventSchema.parse(event)).toEqual(event);
    expect(() => findingOutcomeEventSchema.parse({ ...event, reasonCode: undefined })).toThrow();
    expect(() =>
      findingOutcomeEventSchema.parse({ ...event, kind: "published", reasonCode: "cap" }),
    ).toThrow();
    expect(() =>
      findingOutcomeEventSchema.parse({
        ...event,
        kind: "replied",
        reasonCode: undefined,
      }),
    ).toThrow();
    expect(
      findingOutcomeEventSchema.parse({
        ...event,
        kind: "replied",
        reasonCode: undefined,
        actorPermission: "write",
      }),
    ).toMatchObject({ kind: "replied", actorPermission: "write" });
  });

  it("rejects diagnostic content in public events", () => {
    for (const unsafe of [
      { ...event, path: "src/a.ts" },
      { ...event, body: "Secret logic" },
      { ...event, reasonCode: "finding lines fall outside the commentable range" },
      { ...event, facets: { severity: "line one\nline two" } },
      { ...event, headSha: "src/a.ts" },
      { ...event, findingId: "src/a.ts:10" },
    ]) {
      expect(() => findingOutcomeEventSchema.parse(unsafe)).toThrow();
    }
  });

  it("accepts provider model ids and rejects models with whitespace", () => {
    for (const model of [
      "deepseek/deepseek-v4.1-flash",
      "us.anthropic.claude-sonnet:0",
      "openai/gpt-5@2026-01-01",
      "claude-opus-5-5[1m]",
    ]) {
      expect(findingOutcomeEventSchema.parse({ ...event, model }).model).toBe(model);
    }
    for (const model of ["my model", "line\nbreak", "x".repeat(201)]) {
      expect(() => findingOutcomeEventSchema.parse({ ...event, model })).toThrow();
    }
  });

  it("normalizes attribution into values every event accepts", () => {
    const normalized = normalizeFindingAttribution({
      agent: `  Security\nreviewer\t${"a".repeat(300)}`,
      model: " provider/my model\n",
      facets: {
        severity: "high\r\nurgent",
        long: "v".repeat(150),
        "bad key": "dropped",
        empty: "\n",
      },
    });

    expect(normalized.agent).toStartWith("Security reviewer a");
    expect(normalized.agent).toHaveLength(200);
    expect(normalized.model).toBe("provider/my-model");
    expect(normalized.facets).toEqual({ severity: "high urgent", long: "v".repeat(100) });
    expect(findingOutcomeEventSchema.parse({ ...event, ...normalized })).toMatchObject(normalized);
    expect(normalizeFindingAttribution({ agent: " \n ", model: "\t", facets: {} })).toEqual({
      facets: {},
    });
  });

  it("separates the public ledger from diagnostic evidence", () => {
    const evidence = {
      [event.findingId]: {
        path: "src/a.ts",
        rangeId: "range-1",
        side: "RIGHT",
        startLine: 1,
        endLine: 2,
        body: "Secret logic",
        baseSha: "d".repeat(40),
        headSha: event.headSha,
      },
    };
    expect(
      diagnosticFindingLedgerSchema.parse({ formatVersion: 1, events: [event], evidence }),
    ).toMatchObject({ evidence });
    expect(findingLedgerSchema.parse({ formatVersion: 1, events: [event] }).events).toHaveLength(1);
    expect(() =>
      findingLedgerSchema.parse({ formatVersion: 1, events: [event], evidence }),
    ).toThrow();
  });

  it("records the host's thread resolution support once per ledger", () => {
    for (const threadResolution of ["available", "unavailable"] as const) {
      expect(
        findingLedgerSchema.parse({ formatVersion: 1, threadResolution, events: [event] }),
      ).toMatchObject({ threadResolution });
    }
    expect(() =>
      findingLedgerSchema.parse({ formatVersion: 1, threadResolution: "partial", events: [] }),
    ).toThrow();
  });
});

describe("Finding dataset cases", () => {
  const datasetCase: FindingDatasetCase = {
    formatVersion: 1,
    id: "fnd_0123456789abcdef",
    description: "Maintainers fixed this finding.",
    label: "fixed",
    source: {
      findingId: "fnd_0123456789abcdef",
      executionId: event.executionId,
      workId: event.workId,
      baseSha: "d".repeat(40),
      headSha: event.headSha,
      agent: event.agent,
      model: event.model,
      facets: event.facets,
    },
    finding: { path: "src/a.ts", side: "RIGHT", startLine: 2, endLine: 3, body: "Bug" },
    baseFiles: { "src/a.ts": "one\n" },
    headFiles: { "src/a.ts": "one\ntwo\nthree\n" },
    expected: {
      findings: [
        { path: "src/a.ts", line: 2, keywords: [], selection: { startLine: 2, endLine: 3 } },
      ],
      maxInlineFindings: 1,
    },
    modes: ["live"],
  };

  it("accepts positive and negative labeled cases", () => {
    expect(findingDatasetCaseSchema.parse(datasetCase)).toEqual(datasetCase);
    const negative: FindingDatasetCase = {
      ...datasetCase,
      label: "dismissed",
      expected: { findings: [], maxInlineFindings: 0 },
    };
    expect(findingDatasetCaseSchema.parse(negative)).toEqual(negative);
  });

  it("rejects cases whose expectations disagree with the label", () => {
    expect(() =>
      findingDatasetCaseSchema.parse({
        ...datasetCase,
        label: "dismissed",
      }),
    ).toThrow();
    expect(() =>
      findingDatasetCaseSchema.parse({
        ...datasetCase,
        expected: { findings: [], maxInlineFindings: 0 },
      }),
    ).toThrow();
    expect(() => findingDatasetCaseSchema.parse({ ...datasetCase, extra: true })).toThrow();
  });
});
