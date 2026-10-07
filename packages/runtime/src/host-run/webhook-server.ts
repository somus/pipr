import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type FindingOutcomeEvent,
  type FindingThreadResolution,
  findingOutcomeEventSchema,
  type PiprResult,
  parsePiprResult,
} from "@usepipr/sdk";
import { z } from "zod";
import type { WebhookHost } from "../hosts/selection.js";
import { createCodeHostWebhookProtocol } from "../hosts/webhook.js";
import { enforceRunStoreRetention } from "../observability/retention.js";
import {
  agentStoresDirectoryName,
  resolveRunStoreDirectory,
} from "../observability/retention-store.js";
import type { RuntimeLogSink } from "../shared/logging.js";
import { runHostRunCommand } from "./commands-hosted.js";
import { toPiprErrorResult, toPiprResult } from "./pipr-result.js";
import type { HostRunCommandResult, HostRunFindingEvents } from "./types.js";

const MAX_WEBHOOK_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type WebhookDelivery = {
  id: string;
  host: WebhookHost;
  payload: string;
  eventName?: string;
};

export type WebhookDeliveryStore = {
  enqueue(delivery: WebhookDelivery): "created" | "duplicate" | "full";
  next(): WebhookDelivery | undefined;
  complete(id: string, result: PiprResult, findings?: HostRunFindingEvents): void;
  /** Records a failed attempt, keeping the Finding Outcome events it recorded before failing. */
  fail(id: string, result: PiprResult, findings?: HostRunFindingEvents): void;
};

/** Runs one delivery, handing the Finding Outcome events it records to `onFindingEvents`. */
type WebhookDeliveryRunner = (
  delivery: WebhookDelivery,
  onFindingEvents: (findings: HostRunFindingEvents) => void,
) => Promise<HostRunCommandResult>;

/** One stored Finding Outcome event with the delivery identity that recorded it. */
export type WebhookFindingEventRecord = {
  host: string;
  repository: string;
  deliveryId: string;
  /** Whether the delivery's code host reports native thread resolution. */
  threadResolution: FindingThreadResolution;
  event: FindingOutcomeEvent;
};

export type FindingEventQuery = {
  repository?: string;
  /** Only events stored at or after this instant. */
  since?: Date;
  /** Newest events to return, 1 to 100,000; defaults to 10,000. */
  limit?: number;
};

const MAX_FINDING_EVENT_READ_LIMIT = 100_000;
const findingThreadResolutionSchema = z.enum(["available", "unavailable"]);

/** Reads stored Finding Outcome events newest first, opening the delivery database read-only. */
export function readFindingEvents(
  databasePath: string,
  query: FindingEventQuery = {},
): WebhookFindingEventRecord[] {
  const limit = query.limit ?? 10_000;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FINDING_EVENT_READ_LIMIT) {
    throw new Error(`--limit must be an integer from 1 to ${MAX_FINDING_EVENT_READ_LIMIT}`);
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Webhook database not found: ${databasePath}`);
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const rows = database
      .query<FindingEventRow, [string | null, string | null, number]>(
        `SELECT ${findingEventColumns} FROM finding_events
         WHERE (?1 IS NULL OR repository = ?1) AND (?2 IS NULL OR created_at >= datetime(?2))
         ORDER BY created_at DESC, id DESC LIMIT ?3`,
      )
      .all(query.repository ?? null, query.since?.toISOString() ?? null, limit);
    return rows.flatMap((row) => {
      const event = storedFindingEvent(row);
      const threadResolution = findingThreadResolutionSchema.safeParse(row.threadResolution);
      return event && threadResolution.success
        ? [
            {
              host: row.host,
              repository: row.repository,
              deliveryId: row.deliveryId,
              threadResolution: threadResolution.data,
              event,
            },
          ]
        : [];
    });
  } finally {
    database.close();
  }
}

type FindingEventRow = {
  host: string;
  repository: string;
  deliveryId: string;
  threadResolution: string;
  eventId: string;
  findingId: string;
  kind: string;
  reasonCode: string | null;
  actorPermission: string | null;
  workId: string;
  executionId: string;
  headSha: string;
  configHash: string | null;
  agent: string | null;
  model: string | null;
  facetsJson: string;
  at: string;
  sequence: number;
};

const findingEventColumns = [
  "host",
  "repository",
  "delivery_id AS deliveryId",
  "thread_resolution AS threadResolution",
  "event_id AS eventId",
  "finding_id AS findingId",
  "kind",
  "reason_code AS reasonCode",
  "actor_permission AS actorPermission",
  "work_id AS workId",
  "execution_id AS executionId",
  "head_sha AS headSha",
  "config_hash AS configHash",
  "agent",
  "model",
  "facets_json AS facetsJson",
  "at",
  "sequence",
].join(", ");

function storedFindingEvent(row: FindingEventRow): FindingOutcomeEvent | undefined {
  let facets: unknown;
  try {
    facets = JSON.parse(row.facetsJson);
  } catch {
    return undefined;
  }
  const parsed = findingOutcomeEventSchema.safeParse({
    eventId: row.eventId,
    findingId: row.findingId,
    kind: row.kind,
    ...(row.reasonCode === null ? {} : { reasonCode: row.reasonCode }),
    ...(row.actorPermission === null ? {} : { actorPermission: row.actorPermission }),
    workId: row.workId,
    executionId: row.executionId,
    headSha: row.headSha,
    ...(row.configHash === null ? {} : { configHash: row.configHash }),
    ...(row.agent === null ? {} : { agent: row.agent }),
    ...(row.model === null ? {} : { model: row.model }),
    facets,
    at: row.at,
    sequence: row.sequence,
  });
  return parsed.success ? parsed.data : undefined;
}

export type WebhookDeliveryStatus = {
  id: string;
  host: string;
  status: string;
  attempts: number;
  resultKind?: string;
  runId?: string;
  updatedAt: string;
  result?: PiprResult;
  resultOmittedReason?: "size-limit" | "retention" | "invalid";
};

export function readWebhookDeliveryStatus(
  databasePath: string,
  limit = 20,
): WebhookDeliveryStatus[] {
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("--limit must be an integer from 1 to 200");
  }
  if (!existsSync(databasePath)) {
    throw new Error(`Webhook database not found: ${databasePath}`);
  }
  const database = new Database(databasePath, { readonly: true, strict: true });
  try {
    const rows = database
      .query<
        {
          id: string;
          host: string;
          status: string;
          attempts: number;
          resultKind: string | null;
          runId: string | null;
          resultJson: string | null;
          omittedReason: string | null;
          updatedAt: string;
        },
        [number]
      >(
        "SELECT id, host, status, attempts, result_kind AS resultKind, run_id AS runId, result_json AS resultJson, result_omitted_reason AS omittedReason, updated_at AS updatedAt FROM webhook_deliveries ORDER BY updated_at DESC, id DESC LIMIT ?",
      )
      .all(limit);
    return rows.map((row) => deliveryStatus(row));
  } finally {
    database.close();
  }
}

function deliveryStatus(row: {
  id: string;
  host: string;
  status: string;
  attempts: number;
  resultKind: string | null;
  runId: string | null;
  resultJson: string | null;
  omittedReason: string | null;
  updatedAt: string;
}): WebhookDeliveryStatus {
  const common = {
    id: row.id,
    host: row.host,
    status: row.status,
    attempts: row.attempts,
    ...(row.resultKind ? { resultKind: row.resultKind } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    updatedAt: row.updatedAt,
  };
  if (!row.resultJson) {
    const reason = row.omittedReason;
    return reason === "size-limit" || reason === "retention"
      ? { ...common, resultOmittedReason: reason }
      : common;
  }
  try {
    return { ...common, result: parsePiprResult(JSON.parse(row.resultJson)) };
  } catch {
    return { ...common, resultOmittedReason: "invalid" };
  }
}

export function createWebhookIngress(options: {
  host: WebhookHost;
  secret: string;
  expectedRepository: unknown;
  store: WebhookDeliveryStore;
  maxPayloadBytes?: number;
}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_WEBHOOK_PAYLOAD_BYTES;
  const protocol = createCodeHostWebhookProtocol(options.host);
  return async (request: Request): Promise<Response> => {
    const healthResponse = webhookHealthResponse(request);
    if (healthResponse) return healthResponse;
    const authenticated = await readAuthenticatedWebhookPayload(
      request,
      maxPayloadBytes,
      options.secret,
      protocol.verifySecret,
    );
    if (authenticated instanceof Response) return authenticated;
    const payload = authenticated;
    if (!protocol.matchesExpectedRepository(payload, options.expectedRepository)) {
      return new Response("Repository mismatch", { status: 403 });
    }
    const id = protocol.deliveryId(request.headers, payload);
    if (!id) {
      return new Response("Missing delivery id", { status: 400 });
    }
    const result = options.store.enqueue({
      id,
      host: options.host,
      payload,
      eventName: protocol.eventName?.(request.headers),
    });
    if (result === "full") {
      return new Response("Queue Full", { status: 503, headers: { "Retry-After": "30" } });
    }
    return new Response(result === "created" ? "Accepted" : "Duplicate", {
      status: result === "created" ? 202 : 200,
    });
  };
}

function webhookHealthResponse(request: Request): Response | undefined {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  return new URL(request.url).pathname === "/healthz" ? new Response("OK") : undefined;
}

async function readAuthenticatedWebhookPayload(
  request: Request,
  maxPayloadBytes: number,
  secret: string,
  verify: (headers: Headers, secret: string, payload: string) => boolean,
): Promise<string | Response> {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const payload = await request.text();
  if (new TextEncoder().encode(payload).byteLength > maxPayloadBytes)
    return new Response("Payload Too Large", { status: 413 });
  return verify(request.headers, secret, payload)
    ? payload
    : new Response("Unauthorized", { status: 401 });
}

export async function processNextWebhookDelivery(options: {
  store: WebhookDeliveryStore;
  run: WebhookDeliveryRunner;
  log?: (message: string) => void;
}): Promise<boolean> {
  const delivery = options.store.next();
  if (!delivery) return false;
  let findings: HostRunFindingEvents | undefined;
  try {
    const result = await options.run(delivery, (recorded) => {
      findings = recorded;
    });
    options.store.complete(delivery.id, toPiprResult({ source: "host", result }), findings);
    options.log?.(`webhook delivery completed: ${delivery.id.slice(0, 200)}`);
  } catch (error) {
    options.store.fail(delivery.id, toPiprErrorResult(error), findings);
    options.log?.(
      `webhook delivery failed and was retained for retry or inspection: ${delivery.id.slice(0, 200)}`,
    );
  }
  return true;
}

export function createWebhookQueueProcessor(options: {
  store: WebhookDeliveryStore;
  run: WebhookDeliveryRunner;
  log?: (message: string) => void;
}) {
  let active: Promise<void> | undefined;
  let stopped = false;

  return {
    run(): Promise<void> {
      if (stopped) return Promise.resolve();
      active ??= (async () => {
        try {
          while (await processNextWebhookDelivery(options)) {
            // Deliveries run serially because each checkout mutates the shared workspace.
          }
        } catch {
          options.log?.("webhook queue processing failed; the next interval will retry");
        }
      })().finally(() => {
        active = undefined;
      });
      return active;
    },
    async stop(): Promise<void> {
      stopped = true;
      await active;
    },
  };
}

export async function runWebhookServer(options: {
  host: WebhookHost;
  workspace: string;
  configDir: string;
  databasePath: string;
  expectedRepository: string;
  secret: string;
  port: number;
  hostname?: string;
  env?: NodeJS.ProcessEnv;
  runStoreDirectory?: string;
  runRetentionDays?: number;
  runMaxBytes?: number;
}): Promise<void> {
  await mkdir(path.dirname(path.resolve(options.databasePath)), { recursive: true });
  const env = { ...process.env, ...options.env };
  const protocol = createCodeHostWebhookProtocol(options.host);
  const expectedRepository = await protocol.resolveExpectedRepository(
    env,
    options.expectedRepository,
  );
  const runStoreDirectory = resolveRunStoreDirectory({
    configured: options.runStoreDirectory,
    env,
    mode: "webhook",
  });
  const runRetentionDays =
    options.runRetentionDays ?? integerSetting(env.PIPR_RUN_RETENTION_DAYS, 14);
  const runMaxBytes = options.runMaxBytes ?? integerSetting(env.PIPR_RUN_MAX_BYTES, 5 * 1024 ** 3);
  await enforceRunStoreRetention({
    rootDirectory: runStoreDirectory,
    retentionDays: runRetentionDays,
    maxBytes: runMaxBytes,
  });
  const store = new SqliteWebhookDeliveryStore(options.databasePath, {
    retentionDays: runRetentionDays,
  });
  const ingress = createWebhookIngress({
    host: options.host,
    secret: options.secret,
    expectedRepository,
    store,
  });
  const processor = createWebhookQueueProcessor({
    store,
    run: async (delivery, onFindingEvents) => {
      try {
        return await runWebhookDelivery(delivery, {
          ...options,
          env,
          runStoreDirectory,
          onFindingEvents,
        });
      } finally {
        try {
          await enforceRunStoreRetention({
            rootDirectory: runStoreDirectory,
            retentionDays: runRetentionDays,
            maxBytes: runMaxBytes,
          });
        } catch (error) {
          console.error(
            `pipr warning run retention cleanup failed: ${
              error instanceof Error ? error.message : "unknown retention error"
            }`,
          );
        }
      }
    },
    log: console.error,
  });
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    maxRequestBodySize: MAX_WEBHOOK_PAYLOAD_BYTES,
    fetch: ingress,
  });
  const interval = setInterval(() => void processor.run(), 250);
  const shutdown = Promise.withResolvers<void>();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    stopping ??= (async () => {
      clearInterval(interval);
      server.stop();
      await processor.stop();
      store.close();
    })();
    void stopping.then(shutdown.resolve, shutdown.reject);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    console.error(`pipr webhook server listening on ${server.hostname}:${server.port}`);
    await processor.run();
    await shutdown.promise;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export class SqliteWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly database: Database;
  private readonly maxPendingDeliveries: number;
  private readonly maxRetainedPayloadBytes: number;
  private readonly maxRetainedDeliveries: number;
  private readonly maxResultBytes: number;
  private readonly maxRetainedResultBytes: number;
  private readonly retentionDays: number;
  private readonly maxRetainedFindingEvents: number;

  constructor(
    databasePath: string,
    options: {
      maxPendingDeliveries?: number;
      maxRetainedPayloadBytes?: number;
      maxRetainedDeliveries?: number;
      maxResultBytes?: number;
      maxRetainedResultBytes?: number;
      /** Age limit for stored Finding Outcome events; matches the run store retention. */
      retentionDays?: number;
      maxRetainedFindingEvents?: number;
    } = {},
  ) {
    this.database = new Database(databasePath, { create: true, strict: true });
    this.maxPendingDeliveries = options.maxPendingDeliveries ?? 1_000;
    this.maxRetainedPayloadBytes = options.maxRetainedPayloadBytes ?? 32 * 1024 * 1024;
    this.maxRetainedDeliveries = options.maxRetainedDeliveries ?? 10_000;
    this.maxResultBytes = options.maxResultBytes ?? 512 * 1024;
    this.maxRetainedResultBytes = options.maxRetainedResultBytes ?? 32 * 1024 * 1024;
    this.retentionDays = options.retentionDays ?? 14;
    this.maxRetainedFindingEvents = options.maxRetainedFindingEvents ?? 100_000;
    secureWebhookDatabaseFiles(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    secureWebhookDatabaseFiles(databasePath);
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          host TEXT NOT NULL,
          payload TEXT,
          event_name TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          run_id TEXT,
          result_kind TEXT,
          result_json TEXT,
          result_omitted_reason TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS finding_events (
          id INTEGER PRIMARY KEY,
          event_id TEXT NOT NULL UNIQUE,
          host TEXT NOT NULL,
          repository TEXT NOT NULL,
          delivery_id TEXT NOT NULL,
          thread_resolution TEXT NOT NULL,
          finding_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          reason_code TEXT,
          actor_permission TEXT,
          work_id TEXT NOT NULL,
          execution_id TEXT NOT NULL,
          head_sha TEXT NOT NULL,
          config_hash TEXT,
          agent TEXT,
          model TEXT,
          facets_json TEXT NOT NULL,
          at TEXT NOT NULL,
          sequence INTEGER NOT NULL,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS finding_events_repository_created_at
          ON finding_events (repository, created_at);
        CREATE INDEX IF NOT EXISTS finding_events_created_at ON finding_events (created_at);
      `);
      this.database
        .query(
          "UPDATE webhook_deliveries SET status = 'pending', updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND attempts < 3",
        )
        .run();
      const interrupted = toPiprErrorResult(undefined);
      const stored = this.storedResult(interrupted);
      this.database
        .query(
          "UPDATE webhook_deliveries SET status = 'failed', payload = NULL, error = ?, run_id = ?, result_kind = ?, result_json = ?, result_omitted_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing' AND attempts >= 3",
        )
        .run(
          interrupted.message,
          stored.runId,
          interrupted.kind,
          stored.json,
          stored.omittedReason,
        );
      this.enforceResultRetention();
      this.pruneFindingEvents();
    })();
  }

  enqueue(delivery: WebhookDelivery): "created" | "duplicate" | "full" {
    return this.database.transaction(() => {
      const existing = this.database
        .query<{ id: string }, [string]>("SELECT id FROM webhook_deliveries WHERE id = ?")
        .get(delivery.id);
      if (existing) return "duplicate";
      const retained = this.database
        .query<{ count: number; bytes: number }, []>(
          "SELECT COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM webhook_deliveries WHERE payload IS NOT NULL",
        )
        .get();
      const payloadBytes = Buffer.byteLength(delivery.payload);
      if (
        !retained ||
        retained.count >= this.maxPendingDeliveries ||
        retained.bytes + payloadBytes > this.maxRetainedPayloadBytes
      ) {
        return "full";
      }
      this.database
        .query(
          "INSERT INTO webhook_deliveries (id, host, payload, event_name, status) VALUES (?, ?, ?, ?, 'pending')",
        )
        .run(delivery.id, delivery.host, delivery.payload, delivery.eventName ?? null);
      return "created";
    })();
  }

  next(): WebhookDelivery | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .query<{ id: string; host: WebhookHost; payload: string; eventName?: string }, []>(
          "SELECT id, host, payload, event_name AS eventName FROM webhook_deliveries WHERE status = 'pending' AND attempts < 3 ORDER BY created_at, id LIMIT 1",
        )
        .get();
      if (!row) return undefined;
      this.database
        .query(
          "UPDATE webhook_deliveries SET status = 'processing', attempts = attempts + 1, run_id = NULL, result_kind = NULL, result_json = NULL, result_omitted_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(row.id);
      return row.eventName ? row : { id: row.id, host: row.host, payload: row.payload };
    })();
  }

  complete(id: string, result: PiprResult, findings?: HostRunFindingEvents): void {
    this.database.transaction(() => {
      const stored = this.storedResult(result);
      this.database
        .query(
          "UPDATE webhook_deliveries SET status = 'completed', payload = NULL, error = NULL, run_id = ?, result_kind = ?, result_json = ?, result_omitted_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(stored.runId, result.kind, stored.json, stored.omittedReason, id);
      if (findings) this.insertFindingEvents(id, findings);
      this.enforceResultRetention();
      this.pruneTerminalDeliveries();
    })();
  }

  fail(id: string, result: PiprResult, findings?: HostRunFindingEvents): void {
    this.database.transaction(() => {
      const stored = this.storedResult(result);
      const message = "message" in result ? result.message : "Pipr failed; see logs for details.";
      this.database
        .query(
          "UPDATE webhook_deliveries SET status = CASE WHEN attempts < 3 THEN 'pending' ELSE 'failed' END, payload = CASE WHEN attempts < 3 THEN payload ELSE NULL END, error = ?, run_id = ?, result_kind = ?, result_json = ?, result_omitted_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(message, stored.runId, result.kind, stored.json, stored.omittedReason, id);
      if (findings) this.insertFindingEvents(id, findings);
      this.enforceResultRetention();
      this.pruneTerminalDeliveries();
    })();
  }

  close(): void {
    this.database.close();
  }

  private insertFindingEvents(deliveryId: string, findings: HostRunFindingEvents): void {
    const delivery = this.database
      .query<{ host: string }, [string]>("SELECT host FROM webhook_deliveries WHERE id = ?")
      .get(deliveryId);
    if (!delivery) return;
    const insert = this.database.query(
      `INSERT OR IGNORE INTO finding_events (event_id, host, repository, delivery_id, thread_resolution, finding_id, kind, reason_code, actor_permission, work_id, execution_id, head_sha, config_hash, agent, model, facets_json, at, sequence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const candidate of findings.events) {
      // Re-validate so only the strict public projection reaches the store, never paths or bodies.
      const parsed = findingOutcomeEventSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const event = parsed.data;
      insert.run(
        event.eventId,
        delivery.host,
        findings.repository,
        deliveryId,
        findings.threadResolution,
        event.findingId,
        event.kind,
        event.reasonCode ?? null,
        event.actorPermission ?? null,
        event.workId,
        event.executionId,
        event.headSha,
        event.configHash ?? null,
        event.agent ?? null,
        event.model ?? null,
        JSON.stringify(event.facets),
        event.at,
        event.sequence,
      );
    }
    this.pruneFindingEvents();
  }

  private pruneFindingEvents(): void {
    this.database
      .query("DELETE FROM finding_events WHERE created_at < datetime('now', ?)")
      .run(`-${this.retentionDays} days`);
    this.database
      .query(
        "DELETE FROM finding_events WHERE id IN (SELECT id FROM finding_events ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?)",
      )
      .run(this.maxRetainedFindingEvents);
  }

  private pruneTerminalDeliveries(): void {
    // SQLite uses LIMIT -1 to leave the result unbounded after skipping the retained rows.
    this.database
      .query(
        "DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE status IN ('completed', 'failed') ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?)",
      )
      .run(this.maxRetainedDeliveries);
  }

  private storedResult(result: PiprResult): {
    runId: string | null;
    json: string | null;
    omittedReason: string | null;
  } {
    const json = JSON.stringify(result);
    return {
      runId: "run" in result ? result.run.id : null,
      json: Buffer.byteLength(json) <= this.maxResultBytes ? json : null,
      omittedReason: Buffer.byteLength(json) <= this.maxResultBytes ? null : "size-limit",
    };
  }

  private enforceResultRetention(): void {
    let retained =
      this.database
        .query<{ bytes: number }, []>(
          "SELECT COALESCE(SUM(length(CAST(result_json AS BLOB))), 0) AS bytes FROM webhook_deliveries",
        )
        .get()?.bytes ?? 0;
    if (retained <= this.maxRetainedResultBytes) return;
    const rows = this.database
      .query<{ id: string; bytes: number }, []>(
        "SELECT id, length(CAST(result_json AS BLOB)) AS bytes FROM webhook_deliveries WHERE result_json IS NOT NULL ORDER BY updated_at, id",
      )
      .all();
    for (const row of rows) {
      if (retained <= this.maxRetainedResultBytes) break;
      this.database
        .query(
          "UPDATE webhook_deliveries SET result_json = NULL, result_omitted_reason = 'retention' WHERE id = ?",
        )
        .run(row.id);
      retained -= row.bytes;
    }
  }
}

function secureWebhookDatabaseFiles(databasePath: string): void {
  if (databasePath === ":memory:") return;
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) chmodSync(candidate, 0o600);
  }
}

export async function runWebhookDelivery(
  delivery: WebhookDelivery,
  options: {
    workspace: string;
    configDir: string;
    env?: NodeJS.ProcessEnv;
    runStoreDirectory?: string;
    onFindingEvents?: (findings: HostRunFindingEvents) => void;
  },
  runHostRun: typeof runHostRunCommand = runHostRunCommand,
): Promise<HostRunCommandResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-"));
  const eventPath = path.join(directory, "event.json");
  const protocol = createCodeHostWebhookProtocol(delivery.host);
  const runStoreDirectory = resolveRunStoreDirectory({
    configured: options.runStoreDirectory,
    env: options.env ?? {},
    mode: "webhook",
  });
  try {
    await writeFile(eventPath, delivery.payload, { mode: 0o600 });
    return await runHostRun({
      rootDir: options.workspace,
      configDir: options.configDir,
      host: delivery.host,
      eventPath,
      env: {
        ...process.env,
        ...options.env,
        PIPR_CODE_HOST: delivery.host,
        PIPR_RUN_STORE_DIR: runStoreDirectory,
        ...protocol.runtimeEnv?.(delivery.eventName),
      },
      dryRun: false,
      piStoreRoot: path.join(runStoreDirectory, agentStoresDirectoryName),
      logSink: consoleRuntimeLogSink,
      ...(options.onFindingEvents ? { onFindingEvents: options.onFindingEvents } : {}),
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const consoleRuntimeLogSink: RuntimeLogSink = {
  log(record) {
    console.log(JSON.stringify(record));
  },
  async group(_name, run) {
    return await run();
  },
};

function integerSetting(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received '${value}'`);
  }
  return parsed;
}
