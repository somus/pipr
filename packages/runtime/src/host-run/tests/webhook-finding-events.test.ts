import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FindingOutcomeEvent } from "@usepipr/sdk";
import type { HostRunCommandResult } from "../types.js";
import {
  processNextWebhookDelivery,
  readFindingEvents,
  SqliteWebhookDeliveryStore,
} from "../webhook-server.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function databasePath(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-findings-"));
  directories.push(directory);
  return path.join(directory, "webhook.sqlite");
}

function findingEvent(
  sequence: number,
  overrides: Partial<FindingOutcomeEvent> = {},
): FindingOutcomeEvent {
  return {
    eventId: sequence.toString(16).padStart(64, "0"),
    findingId: `fnd_${sequence.toString(16).padStart(16, "0")}`,
    kind: "published",
    workId: "run-1",
    executionId: "a".repeat(32),
    headSha: "head",
    configHash: "c".repeat(64),
    agent: "reviewer",
    model: "deepseek-v4-pro",
    facets: { severity: "major" },
    at: "2026-10-07T10:00:00.000Z",
    sequence,
    ...overrides,
  };
}

function verifierResult(
  findingEvents: FindingOutcomeEvent[],
  repository = "somus/pipr",
): HostRunCommandResult {
  return {
    kind: "verifier",
    run: {
      id: "run-1",
      trigger: "verifier",
      baseSha: "base",
      headSha: "head",
      tasks: ["pipr-internal-verifier"],
      durationMs: 1,
      models: ["deepseek-v4-pro"],
      agentRuns: 1,
      inputTokens: 1,
      outputTokens: 1,
      costUsd: 0,
      usageStatus: "complete",
    },
    event: {
      eventName: "merge_request",
      platform: { id: "gitlab" },
      repository: { slug: repository },
      change: {
        number: 42,
        title: "Change",
        description: "",
        base: { sha: "base", ref: "main" },
        head: { sha: "head", ref: "feature" },
      },
      workspace: "/workspace",
    },
    configSource: "/workspace/.pipr/config.ts",
    errors: [],
    findingEvents,
  };
}

async function deliver(
  store: SqliteWebhookDeliveryStore,
  id: string,
  result: HostRunCommandResult,
): Promise<void> {
  expect(store.enqueue({ id, host: "gitlab", payload: "{}" })).toBe("created");
  await processNextWebhookDelivery({ store, run: async () => result });
}

function ageEvents(database: string, days: number): void {
  const db = new Database(database, { strict: true });
  try {
    db.query("UPDATE finding_events SET created_at = datetime('now', ?)").run(`-${days} days`);
  } finally {
    db.close();
  }
}

describe("webhook finding events", () => {
  it("stores content-free finding events from a completed delivery", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database);
    const events = [
      findingEvent(1, { kind: "dropped", reasonCode: "out-of-range" }),
      findingEvent(2),
    ];
    await deliver(store, "delivery-1", verifierResult(events));
    store.close();

    expect(readFindingEvents(database).map((record) => record.event)).toEqual(events.toReversed());
    expect(readFindingEvents(database)[0]).toMatchObject({
      host: "gitlab",
      repository: "somus/pipr",
      deliveryId: "delivery-1",
    });
  });

  it("does not double count events from redelivered work", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database);
    const events = [findingEvent(1), findingEvent(2)];
    await deliver(store, "delivery-1", verifierResult(events));
    await deliver(store, "delivery-2", verifierResult(events));
    store.close();

    expect(readFindingEvents(database)).toHaveLength(2);
  });

  it("rejects malformed or diagnostic events without storing them", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database);
    const diagnostic = { ...findingEvent(1), path: "src/secret.ts", body: "private body" };
    const missingReason = findingEvent(2, { kind: "dropped" });
    await deliver(
      store,
      "delivery-1",
      verifierResult([diagnostic as FindingOutcomeEvent, missingReason, findingEvent(3)]),
    );
    store.close();

    expect(readFindingEvents(database).map((record) => record.event.sequence)).toEqual([3]);
    const raw = new Database(database, { readonly: true });
    try {
      expect(JSON.stringify(raw.query("SELECT * FROM finding_events").all())).not.toContain(
        "src/secret.ts",
      );
    } finally {
      raw.close();
    }
  });

  it("prunes events older than the retention window", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database, { retentionDays: 14 });
    await deliver(store, "delivery-1", verifierResult([findingEvent(1)]));
    store.close();
    ageEvents(database, 15);

    const reopened = new SqliteWebhookDeliveryStore(database, { retentionDays: 14 });
    expect(readFindingEvents(database)).toEqual([]);
    await deliver(reopened, "delivery-2", verifierResult([findingEvent(2)]));
    ageEvents(database, 15);
    await deliver(reopened, "delivery-3", verifierResult([findingEvent(3)]));
    reopened.close();

    expect(readFindingEvents(database).map((record) => record.event.sequence)).toEqual([3]);
  });

  it("caps retained events and keeps the newest rows", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database, { maxRetainedFindingEvents: 2 });
    await deliver(store, "delivery-1", verifierResult([findingEvent(1), findingEvent(2)]));
    await deliver(store, "delivery-2", verifierResult([findingEvent(3)]));
    store.close();

    expect(readFindingEvents(database).map((record) => record.event.sequence)).toEqual([3, 2]);
  });

  it("filters reads by repository, age, and limit", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database);
    await deliver(store, "delivery-1", verifierResult([findingEvent(1)], "somus/old"));
    ageEvents(database, 3);
    await deliver(store, "delivery-2", verifierResult([findingEvent(2)], "somus/pipr"));
    await deliver(store, "delivery-3", verifierResult([findingEvent(3)], "somus/other"));
    store.close();

    expect(
      readFindingEvents(database, { repository: "somus/pipr" }).map((r) => r.event.sequence),
    ).toEqual([2]);
    expect(
      readFindingEvents(database, { since: new Date(Date.now() - 24 * 60 * 60 * 1000) }).map(
        (r) => r.event.sequence,
      ),
    ).toEqual([3, 2]);
    expect(readFindingEvents(database, { limit: 1 }).map((r) => r.event.sequence)).toEqual([3]);
    expect(() => readFindingEvents(database, { limit: 0 })).toThrow("--limit");
    expect(() => readFindingEvents(path.join(path.dirname(database), "missing.sqlite"))).toThrow(
      "Webhook database not found",
    );
  });

  it("skips stored rows that no longer satisfy the public event schema", async () => {
    const database = await databasePath();
    const store = new SqliteWebhookDeliveryStore(database);
    await deliver(store, "delivery-1", verifierResult([findingEvent(1), findingEvent(2)]));
    store.close();
    const db = new Database(database, { strict: true });
    try {
      db.query("UPDATE finding_events SET facets_json = 'not json' WHERE sequence = 1").run();
    } finally {
      db.close();
    }

    expect(readFindingEvents(database).map((record) => record.event.sequence)).toEqual([2]);
  });
});
