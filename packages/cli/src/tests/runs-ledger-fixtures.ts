import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  DiagnosticFindingLedger,
  FindingOutcomeEvent,
  FindingOutcomeKind,
} from "@usepipr/sdk";

export const secretPath = "src/secret-billing.ts";
export const secretBody = "Private finding body about the refund branch";

export function ledgerEvent(
  executionId: string,
  findingId: string,
  kind: FindingOutcomeKind,
  overrides: Partial<FindingOutcomeEvent> = {},
): FindingOutcomeEvent {
  return {
    eventId: createHash("sha256").update(`${findingId}|${kind}|${executionId}`).digest("hex"),
    findingId,
    kind,
    ...(kind === "dropped" ? { reasonCode: "cap" as const } : {}),
    ...(kind === "replied" ? { actorPermission: "write" as const } : {}),
    workId: "run_1",
    executionId,
    headSha: "head",
    configHash: "c".repeat(64),
    agent: "reviewer",
    model: "deepseek-reasoner",
    facets: { severity: "high" },
    at: "2026-07-20T10:00:00.000Z",
    sequence: 0,
    ...overrides,
  };
}

/** Writes a finalized diagnostic Run Bundle whose only artifact is a Finding Outcome ledger. */
export async function writeLedgerBundle(
  store: string,
  executionId: string,
  ledger: DiagnosticFindingLedger,
  options: { startedAt?: string; host?: "github" | "gitea" | "local" } = {},
): Promise<void> {
  const directory = path.join(store, executionId);
  await mkdir(path.join(directory, "artifacts"), { recursive: true });
  const startedAt = options.startedAt ?? "2026-07-20T10:00:00.000Z";
  const endedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
  const ledgerContents = `${JSON.stringify(ledger)}\n`;
  await writeFile(path.join(directory, "artifacts", "ledger.json"), ledgerContents);
  await writeFile(
    path.join(directory, "spans.jsonl"),
    `${JSON.stringify({
      formatVersion: 1,
      traceId: executionId,
      spanId: "0123456789abcdef",
      name: "pipr.run",
      category: "run",
      startedAt,
      endedAt,
      durationMs: 1000,
      status: "ok",
      attributes: {},
    })}\n`,
  );
  await writeFile(path.join(directory, "logs.jsonl"), "");
  await writeFile(
    path.join(directory, "metrics.json"),
    JSON.stringify({ formatVersion: 1, counters: [], histograms: [] }),
  );
  await writeFile(
    path.join(directory, "run.json"),
    JSON.stringify({
      formatVersion: 1,
      executionId,
      kind: "review",
      outcome: "succeeded",
      startedAt,
      endedAt,
      durationMs: 1000,
      repository: {
        host: options.host ?? "github",
        repository: "somus/pipr",
        changeNumber: 42,
        baseSha: "base",
        headSha: "head",
      },
      pipr: { version: "0.8.0" },
      capture: {
        mode: "diagnostic",
        completeness: "complete",
        redactionApplied: true,
        truncated: false,
        limitBytes: 67_108_864,
        finalizationTimedOut: false,
        errors: [],
      },
      export: { otlp: "disabled", externalUpload: "not-configured" },
      resources: { runtime: "bun 1.4.2" },
      signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
      artifacts: [
        {
          kind: "ledger",
          path: "artifacts/ledger.json",
          mediaType: "application/json",
          sizeBytes: Buffer.byteLength(ledgerContents),
          sha256: createHash("sha256").update(ledgerContents).digest("hex"),
          sensitive: true,
          truncated: false,
        },
      ],
    }),
  );
}

/** Creates a webhook delivery database holding `finding_events` rows like `pipr webhook serve`. */
export function writeWebhookFindingEvents(
  databasePath: string,
  rows: Array<{ host: string; repository: string; event: FindingOutcomeEvent }>,
): void {
  const database = new Database(databasePath, { create: true, strict: true });
  try {
    database.run(`CREATE TABLE finding_events (
      id INTEGER PRIMARY KEY, event_id TEXT NOT NULL UNIQUE, host TEXT NOT NULL,
      repository TEXT NOT NULL, delivery_id TEXT NOT NULL, finding_id TEXT NOT NULL,
      kind TEXT NOT NULL, reason_code TEXT, actor_permission TEXT, work_id TEXT NOT NULL,
      execution_id TEXT NOT NULL, head_sha TEXT NOT NULL, config_hash TEXT, agent TEXT,
      model TEXT, facets_json TEXT NOT NULL, at TEXT NOT NULL, sequence INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
    const insert = database.query(
      `INSERT INTO finding_events (event_id, host, repository, delivery_id, finding_id, kind,
        reason_code, actor_permission, work_id, execution_id, head_sha, config_hash, agent, model,
        facets_json, at, sequence)
       VALUES ($eventId, $host, $repository, 'delivery-1', $findingId, $kind, $reasonCode,
        $actorPermission, $workId, $executionId, $headSha, $configHash, $agent, $model, $facets,
        $at, $sequence)`,
    );
    for (const { host, repository, event } of rows) {
      insert.run({
        eventId: event.eventId,
        host,
        repository,
        findingId: event.findingId,
        kind: event.kind,
        reasonCode: event.reasonCode ?? null,
        actorPermission: event.actorPermission ?? null,
        workId: event.workId,
        executionId: event.executionId,
        headSha: event.headSha,
        configHash: event.configHash ?? null,
        agent: event.agent ?? null,
        model: event.model ?? null,
        facets: JSON.stringify(event.facets),
        at: event.at,
        sequence: event.sequence,
      });
    }
  } finally {
    database.close();
  }
}
