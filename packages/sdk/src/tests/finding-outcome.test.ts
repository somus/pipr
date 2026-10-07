import { describe, expect, it } from "bun:test";
import {
  diagnosticFindingLedgerSchema,
  type FindingOutcomeEvent,
  findingLedgerSchema,
  findingOutcomeEventSchema,
} from "../index.js";

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
});
