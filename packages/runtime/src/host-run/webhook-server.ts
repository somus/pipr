import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type PiprResult, parsePiprResult } from "@usepipr/sdk";
import { createCodeHostWebhookProtocol, type WebhookHost } from "../hosts/webhook.js";
import type { RuntimeLogSink } from "../shared/logging.js";
import { type HostRunCommandResult, runHostRunCommand } from "./commands.js";
import { toPiprErrorResult, toPiprResult } from "./result.js";

const MAX_WEBHOOK_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_WEBHOOK_RESULT_BYTES = 512 * 1024;
const MAX_RETAINED_RESULT_BYTES = 32 * 1024 * 1024;

export type { WebhookHost } from "../hosts/webhook.js";

export type WebhookDelivery = {
  id: string;
  host: WebhookHost;
  payload: string;
  eventName?: string;
};

export type WebhookStatus = {
  formatVersion: 1;
  deliveries: Array<{
    id: string;
    host: WebhookHost;
    status: "pending" | "processing" | "completed" | "failed";
    attempts: number;
    eventName: string | null;
    resultKind: PiprResult["kind"] | null;
    runId: string | null;
    result: PiprResult | null;
    resultOmittedReason: "size-limit" | "retention" | "invalid" | null;
    createdAt: string;
    updatedAt: string;
  }>;
};

export type WebhookDeliveryStore = {
  enqueue(delivery: WebhookDelivery): "created" | "duplicate" | "full";
  next(): WebhookDelivery | undefined;
  complete(id: string, result: PiprResult): void;
  fail(id: string, result: PiprResult): void;
};

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
  run: (delivery: WebhookDelivery) => Promise<HostRunCommandResult>;
  log?: (message: string) => void;
}): Promise<boolean> {
  const delivery = options.store.next();
  if (!delivery) return false;
  try {
    const result = await options.run(delivery);
    options.store.complete(delivery.id, toPiprResult({ source: "host", result }));
    options.log?.(`webhook delivery completed: ${delivery.id.slice(0, 200)}`);
  } catch (error) {
    options.store.fail(delivery.id, toPiprErrorResult(error));
    options.log?.(
      `webhook delivery failed and was retained for retry or inspection: ${delivery.id.slice(0, 200)}`,
    );
  }
  return true;
}

export async function readWebhookStatus(
  databasePath: string,
  options: { limit?: number } = {},
): Promise<WebhookStatus> {
  const limit = options.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new Error("webhook status limit must be an integer between 1 and 200");
  }
  await access(databasePath);
  const migration = new SqliteWebhookDeliveryStore(databasePath, { recoverProcessing: false });
  migration.close();
  const database = new Database(databasePath, { readonly: true, strict: true });

  try {
    const rows = database
      .query(
        `SELECT id, host, status, attempts, event_name AS eventName, result_kind AS resultKind, run_id AS runId,
                result_json AS resultJson, result_omitted_reason AS resultOmittedReason, created_at AS createdAt, updated_at AS updatedAt
         FROM webhook_deliveries
         ORDER BY updated_at DESC, id DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      host: WebhookHost;
      status: "pending" | "processing" | "completed" | "failed";
      attempts: number;
      eventName: string | null;
      resultKind: PiprResult["kind"] | null;
      runId: string | null;
      resultJson: string | null;
      resultOmittedReason: "size-limit" | "retention" | null;
      createdAt: string;
      updatedAt: string;
    }>;

    return {
      formatVersion: 1,
      deliveries: rows.map(({ resultJson, resultOmittedReason, ...row }) => {
        const parsed = parseStoredWebhookResult(resultJson);
        return {
          ...row,
          result: parsed.result,
          resultOmittedReason: parsed.invalid ? "invalid" : resultOmittedReason,
        };
      }),
    };
  } finally {
    database.close();
  }
}

function parseStoredWebhookResult(resultJson: string | null): {
  result: PiprResult | null;
  invalid: boolean;
} {
  if (resultJson == null) return { result: null, invalid: false };
  try {
    return { result: parsePiprResult(JSON.parse(resultJson)), invalid: false };
  } catch {
    return { result: null, invalid: true };
  }
}

export function createWebhookQueueProcessor(options: {
  store: WebhookDeliveryStore;
  run: (delivery: WebhookDelivery) => Promise<HostRunCommandResult>;
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
}): Promise<void> {
  await mkdir(path.dirname(path.resolve(options.databasePath)), { recursive: true });
  const env = { ...process.env, ...options.env };
  const protocol = createCodeHostWebhookProtocol(options.host);
  const expectedRepository = await protocol.resolveExpectedRepository(
    env,
    options.expectedRepository,
  );
  const store = new SqliteWebhookDeliveryStore(options.databasePath);
  const ingress = createWebhookIngress({
    host: options.host,
    secret: options.secret,
    expectedRepository,
    store,
  });
  const processor = createWebhookQueueProcessor({
    store,
    run: (delivery) => runWebhookDelivery(delivery, { ...options, env }),
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

  constructor(
    databasePath: string,
    options: {
      maxPendingDeliveries?: number;
      maxRetainedPayloadBytes?: number;
      maxRetainedDeliveries?: number;
      maxResultBytes?: number;
      maxRetainedResultBytes?: number;
      recoverProcessing?: boolean;
    } = {},
  ) {
    this.database = new Database(databasePath, { create: true, strict: true });
    this.maxPendingDeliveries = options.maxPendingDeliveries ?? 1_000;
    this.maxRetainedPayloadBytes = options.maxRetainedPayloadBytes ?? 32 * 1024 * 1024;
    this.maxRetainedDeliveries = options.maxRetainedDeliveries ?? 10_000;
    this.maxResultBytes = options.maxResultBytes ?? MAX_WEBHOOK_RESULT_BYTES;
    this.maxRetainedResultBytes = options.maxRetainedResultBytes ?? MAX_RETAINED_RESULT_BYTES;
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          host TEXT NOT NULL,
          payload TEXT,
          run_id TEXT,
          event_name TEXT,
          result_kind TEXT,
          result_json TEXT,
          result_omitted_reason TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
      `);
      const columns = this.database
        .query<{ name: string }, []>("PRAGMA table_info(webhook_deliveries)")
        .all();
      if (!columns.some((column) => column.name === "run_id")) {
        this.database.exec("ALTER TABLE webhook_deliveries ADD COLUMN run_id TEXT");
      }
      if (!columns.some((column) => column.name === "event_name")) {
        this.database.exec("ALTER TABLE webhook_deliveries ADD COLUMN event_name TEXT");
      }
      if (!columns.some((column) => column.name === "result_kind")) {
        this.database.exec("ALTER TABLE webhook_deliveries ADD COLUMN result_kind TEXT");
      }
      if (!columns.some((column) => column.name === "result_json")) {
        this.database.exec("ALTER TABLE webhook_deliveries ADD COLUMN result_json TEXT");
      }
      if (!columns.some((column) => column.name === "result_omitted_reason")) {
        this.database.exec("ALTER TABLE webhook_deliveries ADD COLUMN result_omitted_reason TEXT");
      }
      if (options.recoverProcessing !== false) {
        this.database
          .query(
            "UPDATE webhook_deliveries SET status = CASE WHEN attempts < 3 THEN 'pending' ELSE 'failed' END, payload = CASE WHEN attempts < 3 THEN payload ELSE NULL END, error = CASE WHEN attempts < 3 THEN error ELSE COALESCE(error, 'delivery interrupted during final attempt') END, updated_at = CURRENT_TIMESTAMP WHERE status = 'processing'",
          )
          .run();
      }
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
          "UPDATE webhook_deliveries SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(row.id);
      this.database
        .query(
          "UPDATE webhook_deliveries SET run_id = NULL, result_kind = NULL, result_json = NULL, result_omitted_reason = NULL WHERE id = ?",
        )
        .run(row.id);
      return row.eventName ? row : { id: row.id, host: row.host, payload: row.payload };
    })();
  }

  complete(id: string, result: PiprResult): void {
    this.finish(id, result, "completed");
  }

  fail(id: string, result: PiprResult): void {
    this.finish(id, result, "failed");
  }

  private finish(id: string, result: PiprResult, outcome: "completed" | "failed"): void {
    this.database.transaction(() => {
      const resultJson = JSON.stringify(result);
      const isOmitted = Buffer.byteLength(resultJson) > this.maxResultBytes;
      const completed = outcome === "completed" ? 1 : 0;
      this.database
        .query(
          `UPDATE webhook_deliveries
           SET status = CASE
                 WHEN ? = 1 THEN 'completed'
                 WHEN attempts < 3 THEN 'pending'
                 ELSE 'failed'
               END,
               payload = CASE WHEN ? = 1 OR attempts >= 3 THEN NULL ELSE payload END,
               error = ?,
               run_id = ?,
               result_kind = ?,
               result_json = ?,
               result_omitted_reason = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .run(
          completed,
          completed,
          completed
            ? null
            : result.kind === "error"
              ? result.message
              : "Pipr failed; see logs for details.",
          runIdFromResult(result),
          result.kind,
          isOmitted ? null : resultJson,
          isOmitted ? "size-limit" : null,
          id,
        );
      this.pruneTerminalResultBodies();
      this.pruneTerminalDeliveries();
    })();
  }

  close(): void {
    this.database.close();
  }

  private pruneTerminalResultBodies(): void {
    const rows = this.database
      .query<{ id: string; bytes: number }, []>(
        "SELECT id, COALESCE(length(CAST(result_json AS BLOB)), 0) AS bytes FROM webhook_deliveries WHERE result_json IS NOT NULL ORDER BY updated_at ASC, id ASC",
      )
      .all();
    let retainedBytes = rows.reduce((sum, row) => sum + row.bytes, 0);
    if (retainedBytes <= this.maxRetainedResultBytes) return;

    for (const row of rows) {
      if (retainedBytes <= this.maxRetainedResultBytes) break;
      retainedBytes -= row.bytes;
      this.database
        .query(
          "UPDATE webhook_deliveries SET result_json = NULL, result_omitted_reason = 'retention' WHERE id = ?",
        )
        .run(row.id);
    }
  }

  private pruneTerminalDeliveries(): void {
    // SQLite uses LIMIT -1 to leave the result unbounded after skipping the retained rows.
    this.database
      .query(
        "DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE status IN ('completed', 'failed') ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?)",
      )
      .run(this.maxRetainedDeliveries);
  }
}

function runIdFromResult(result: PiprResult): string | null {
  return "run" in result ? result.run.id : null;
}

export async function runWebhookDelivery(
  delivery: WebhookDelivery,
  options: {
    workspace: string;
    configDir: string;
    env?: NodeJS.ProcessEnv;
  },
  runHostRun: typeof runHostRunCommand = runHostRunCommand,
): Promise<HostRunCommandResult> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-"));
  const eventPath = path.join(directory, "event.json");
  const protocol = createCodeHostWebhookProtocol(delivery.host);
  try {
    await Bun.write(eventPath, delivery.payload);
    return await runHostRun({
      rootDir: options.workspace,
      configDir: options.configDir,
      host: delivery.host,
      eventPath,
      env: {
        ...process.env,
        ...options.env,
        PIPR_CODE_HOST: delivery.host,
        ...protocol.runtimeEnv?.(delivery.eventName),
      },
      dryRun: false,
      logSink: consoleRuntimeLogSink,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export function formatWebhookDeliveryId(value: string): string {
  if (value.length <= 20) return value;
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

const consoleRuntimeLogSink: RuntimeLogSink = {
  log(record) {
    console.log(JSON.stringify(record));
  },
  async group(_name, run) {
    return await run();
  },
};
