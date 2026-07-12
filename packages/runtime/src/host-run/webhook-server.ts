import { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactPotentialSecrets } from "../shared/redaction.js";
import { runHostRunCommand } from "./commands.js";

const MAX_WEBHOOK_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type WebhookHost = "gitlab" | "azure-devops" | "bitbucket";

export type WebhookDelivery = {
  id: string;
  host: WebhookHost;
  payload: string;
};

export type WebhookDeliveryStore = {
  enqueue(delivery: WebhookDelivery): "created" | "duplicate";
  next(): WebhookDelivery | undefined;
  complete(id: string): void;
  fail(id: string, error: string): void;
};

export function createWebhookIngress(options: {
  host: WebhookHost;
  secret: string;
  store: WebhookDeliveryStore;
  maxPayloadBytes?: number;
}) {
  const maxPayloadBytes = options.maxPayloadBytes ?? MAX_WEBHOOK_PAYLOAD_BYTES;
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    if (!verifyWebhookSecret(request.headers, options.host, options.secret)) {
      return new Response("Unauthorized", { status: 401 });
    }
    const id = deliveryId(request.headers, options.host);
    if (!id) {
      return new Response("Missing delivery id", { status: 400 });
    }
    const payload = await request.text();
    if (new TextEncoder().encode(payload).byteLength > maxPayloadBytes) {
      return new Response("Payload Too Large", { status: 413 });
    }
    const result = options.store.enqueue({ id, host: options.host, payload });
    return new Response(result === "created" ? "Accepted" : "Duplicate", {
      status: result === "created" ? 202 : 200,
    });
  };
}

export async function processNextWebhookDelivery(options: {
  store: WebhookDeliveryStore;
  run: (delivery: WebhookDelivery) => Promise<unknown>;
}): Promise<boolean> {
  const delivery = options.store.next();
  if (!delivery) return false;
  try {
    await options.run(delivery);
    options.store.complete(delivery.id);
  } catch (error) {
    const message = redactPotentialSecrets(error instanceof Error ? error.message : String(error));
    options.store.fail(delivery.id, message.slice(0, 1_000));
  }
  return true;
}

export async function runWebhookServer(options: {
  host: WebhookHost;
  workspace: string;
  configDir: string;
  databasePath: string;
  secret: string;
  port: number;
  hostname?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<never> {
  await mkdir(path.dirname(path.resolve(options.databasePath)), { recursive: true });
  const store = new SqliteWebhookDeliveryStore(options.databasePath);
  const ingress = createWebhookIngress({ host: options.host, secret: options.secret, store });
  let processing = false;
  const processQueue = async () => {
    if (processing) return;
    processing = true;
    try {
      while (
        await processNextWebhookDelivery({
          store,
          run: (delivery) => runWebhookDelivery(delivery, options),
        })
      ) {
        // Drain one installation's durable queue serially because checkout mutates the workspace.
      }
    } finally {
      processing = false;
    }
  };
  const server = Bun.serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    maxRequestBodySize: MAX_WEBHOOK_PAYLOAD_BYTES,
    fetch: ingress,
  });
  const interval = setInterval(() => void processQueue(), 250);
  process.once("SIGINT", () => {
    clearInterval(interval);
    server.stop();
    store.close();
  });
  process.once("SIGTERM", () => {
    clearInterval(interval);
    server.stop();
    store.close();
  });
  console.log(`pipr webhook server listening on ${server.hostname}:${server.port}`);
  await processQueue();
  return await new Promise<never>(() => {});
}

export class SqliteWebhookDeliveryStore implements WebhookDeliveryStore {
  private readonly database: Database;

  constructor(databasePath: string) {
    this.database = new Database(databasePath, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      UPDATE webhook_deliveries SET status = 'pending' WHERE status = 'processing';
    `);
  }

  enqueue(delivery: WebhookDelivery): "created" | "duplicate" {
    const result = this.database
      .query(
        "INSERT OR IGNORE INTO webhook_deliveries (id, host, payload, status) VALUES (?, ?, ?, 'pending')",
      )
      .run(delivery.id, delivery.host, delivery.payload);
    return result.changes === 1 ? "created" : "duplicate";
  }

  next(): WebhookDelivery | undefined {
    return this.database.transaction(() => {
      const row = this.database
        .query<{ id: string; host: WebhookHost; payload: string }, []>(
          "SELECT id, host, payload FROM webhook_deliveries WHERE status = 'pending' AND attempts < 3 ORDER BY created_at, id LIMIT 1",
        )
        .get();
      if (!row) return undefined;
      this.database
        .query(
          "UPDATE webhook_deliveries SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
        )
        .run(row.id);
      return row;
    })();
  }

  complete(id: string): void {
    this.database
      .query(
        "UPDATE webhook_deliveries SET status = 'completed', payload = NULL, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(id);
  }

  fail(id: string, error: string): void {
    this.database
      .query(
        "UPDATE webhook_deliveries SET status = CASE WHEN attempts < 3 THEN 'pending' ELSE 'failed' END, payload = CASE WHEN attempts < 3 THEN payload ELSE NULL END, error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
      .run(error, id);
  }

  close(): void {
    this.database.close();
  }
}

async function runWebhookDelivery(
  delivery: WebhookDelivery,
  options: {
    workspace: string;
    configDir: string;
    env?: NodeJS.ProcessEnv;
  },
): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-"));
  const eventPath = path.join(directory, "event.json");
  try {
    await Bun.write(eventPath, delivery.payload);
    await runHostRunCommand({
      rootDir: options.workspace,
      configDir: options.configDir,
      host: delivery.host,
      eventPath,
      env: { ...options.env, PIPR_CODE_HOST: delivery.host },
      dryRun: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function verifyWebhookSecret(headers: Headers, host: WebhookHost, secret: string): boolean {
  if (host !== "gitlab") return false;
  const supplied = headers.get("X-Gitlab-Token");
  if (!supplied) return false;
  const expectedBytes = Buffer.from(secret);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes)
  );
}

function deliveryId(headers: Headers, host: WebhookHost): string | undefined {
  if (host === "gitlab") {
    const id = headers.get("X-Gitlab-Webhook-UUID") ?? headers.get("X-Gitlab-Event-UUID");
    return id ? `${host}:${id}` : undefined;
  }
  return undefined;
}
