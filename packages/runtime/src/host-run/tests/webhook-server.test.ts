import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWebhookIngress,
  processNextWebhookDelivery,
  SqliteWebhookDeliveryStore,
  type WebhookDelivery,
  type WebhookDeliveryStore,
} from "../webhook-server.js";

describe("webhook runner", () => {
  it("validates GitLab secrets and dedupes delivery IDs before enqueue", async () => {
    const store = new MemoryDeliveryStore();
    const ingress = createWebhookIngress({ host: "gitlab", secret: "webhook-secret", store });
    const request = () =>
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitlab-Token": "webhook-secret",
          "X-Gitlab-Webhook-UUID": "delivery-1",
        },
        body: '{"object_kind":"merge_request"}',
      });

    expect((await ingress(request())).status).toBe(202);
    expect((await ingress(request())).status).toBe(200);
    expect(store.deliveries).toHaveLength(1);
    expect((await ingress(new Request("http://localhost/webhook", { method: "GET" }))).status).toBe(
      405,
    );
    expect(
      (
        await ingress(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: { "X-Gitlab-Token": "wrong", "X-Gitlab-Webhook-UUID": "delivery-2" },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(401);
  });

  it("runs queued deliveries once and records failures without exposing payloads", async () => {
    const store = new MemoryDeliveryStore();
    store.enqueue({ id: "delivery-1", host: "gitlab", payload: '{"safe":true}' });
    const runs: WebhookDelivery[] = [];

    await processNextWebhookDelivery({ store, run: async (delivery) => runs.push(delivery) });
    expect(runs).toHaveLength(1);
    expect(store.completed).toEqual(["delivery-1"]);

    store.enqueue({ id: "delivery-2", host: "gitlab", payload: '{"secret":"not logged"}' });
    await processNextWebhookDelivery({
      store,
      run: async () => {
        throw new Error("provider failed");
      },
    });
    expect(store.failures).toEqual([{ id: "delivery-2", error: "provider failed" }]);
  });

  it("persists delivery dedupe and pending work across SQLite restarts", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const first = new SqliteWebhookDeliveryStore(databasePath);
      expect(first.enqueue({ id: "delivery-1", host: "gitlab", payload: "{}" })).toBe("created");
      first.close();

      const second = new SqliteWebhookDeliveryStore(databasePath);
      expect(second.next()).toEqual({ id: "delivery-1", host: "gitlab", payload: "{}" });
      second.complete("delivery-1");
      second.close();

      const third = new SqliteWebhookDeliveryStore(databasePath);
      expect(third.next()).toBeUndefined();
      expect(third.enqueue({ id: "delivery-1", host: "gitlab", payload: "{}" })).toBe("duplicate");
      third.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("drops retained payload content after the final retry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath);
      store.enqueue({ id: "delivery-1", host: "gitlab", payload: '{"private":"content"}' });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        expect(store.next()?.id).toBe("delivery-1");
        store.fail("delivery-1", "provider failed");
      }
      store.close();

      const database = new Database(databasePath, { readonly: true, strict: true });
      expect(
        database
          .query<{ status: string; payload: string | null }, []>(
            "SELECT status, payload FROM webhook_deliveries WHERE id = 'delivery-1'",
          )
          .get(),
      ).toEqual({ status: "failed", payload: null });
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class MemoryDeliveryStore implements WebhookDeliveryStore {
  deliveries: WebhookDelivery[] = [];
  completed: string[] = [];
  failures: Array<{ id: string; error: string }> = [];
  enqueue(delivery: WebhookDelivery) {
    if (this.deliveries.some((candidate) => candidate.id === delivery.id))
      return "duplicate" as const;
    this.deliveries.push(delivery);
    return "created" as const;
  }
  next() {
    return this.deliveries.find(
      (delivery) =>
        !this.completed.includes(delivery.id) &&
        !this.failures.some((failure) => failure.id === delivery.id),
    );
  }
  complete(id: string) {
    this.completed.push(id);
  }
  fail(id: string, error: string) {
    this.failures.push({ id, error });
  }
}
