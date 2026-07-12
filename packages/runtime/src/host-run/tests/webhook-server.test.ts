import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createWebhookIngress,
  processNextWebhookDelivery,
  runWebhookDelivery,
  SqliteWebhookDeliveryStore,
  type WebhookDelivery,
  type WebhookDeliveryStore,
} from "../webhook-server.js";

describe("webhook runner", () => {
  it("validates GitLab secrets and dedupes delivery IDs before enqueue", async () => {
    const store = new MemoryDeliveryStore();
    const ingress = createWebhookIngress({
      host: "gitlab",
      secret: "webhook-secret",
      expectedRepository: { id: "42", path: "group/project" },
      store,
    });
    const request = () =>
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Gitlab-Token": "webhook-secret",
          "X-Gitlab-Webhook-UUID": "delivery-1",
        },
        body: '{"object_kind":"merge_request","project":{"id":42,"path_with_namespace":"group/project"}}',
      });

    expect((await ingress(request())).status).toBe(202);
    expect((await ingress(request())).status).toBe(200);
    expect(store.deliveries).toHaveLength(1);
    for (const body of [
      '{"project":{"id":42,"path_with_namespace":"other/project"}}',
      '{"project":{"id":99,"path_with_namespace":"group/project"}}',
    ]) {
      expect(
        (
          await ingress(
            new Request("http://localhost/webhook", {
              method: "POST",
              headers: {
                "X-Gitlab-Token": "webhook-secret",
                "X-Gitlab-Webhook-UUID": `mixed-${body.length}`,
              },
              body,
            }),
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await ingress(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: {
              "X-Gitlab-Token": "webhook-secret",
              "X-Gitlab-Webhook-UUID": "delivery-other",
            },
            body: '{"project":{"id":99,"path_with_namespace":"other/project"}}',
          }),
        )
      ).status,
    ).toBe(403);
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

  it("rejects deliveries when the durable pending queue reaches its byte or count budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    try {
      const store = new SqliteWebhookDeliveryStore(path.join(root, "deliveries.sqlite"), {
        maxPendingDeliveries: 1,
        maxRetainedPayloadBytes: 100,
      });
      expect(store.enqueue({ id: "one", host: "gitlab", payload: "x".repeat(60) })).toBe("created");
      expect(store.enqueue({ id: "two", host: "gitlab", payload: "{}" })).toBe("full");
      store.complete("one");
      expect(store.enqueue({ id: "three", host: "gitlab", payload: "x".repeat(101) })).toBe("full");
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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

  it("writes one temporary event, selects GitLab, and cleans up after action execution", async () => {
    const observedPaths: string[] = [];
    await runWebhookDelivery(
      { id: "delivery-1", host: "gitlab", payload: '{"project":{"id":42}}' },
      { workspace: "/workspace", configDir: ".pipr", env: { SAFE: "value" } },
      async (options) => {
        observedPaths.push(options.eventPath ?? "");
        expect(await Bun.file(options.eventPath ?? "").text()).toContain('"id":42');
        expect(options).toMatchObject({
          rootDir: "/workspace",
          configDir: ".pipr",
          host: "gitlab",
          env: { SAFE: "value", PIPR_CODE_HOST: "gitlab" },
          dryRun: false,
        });
        return { kind: "ignored", reason: "test" } as const;
      },
    );
    expect(observedPaths).toHaveLength(1);
    await expect(access(observedPaths[0] ?? "")).rejects.toThrow();
  });

  it("inherits the process environment when delivery options omit env", async () => {
    const name = "PIPR_WEBHOOK_PROCESS_ENV_TEST";
    const previous = process.env[name];
    process.env[name] = "inherited";
    try {
      await runWebhookDelivery(
        { id: "delivery-1", host: "gitlab", payload: "{}" },
        { workspace: "/workspace", configDir: ".pipr" },
        async (options) => {
          expect(options.env?.[name]).toBe("inherited");
          return { kind: "ignored", reason: "test" } as const;
        },
      );
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
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

  it("bounds retained terminal delivery metadata", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath, { maxRetainedDeliveries: 1 });
      for (const id of ["one", "two"]) {
        store.enqueue({ id, host: "gitlab", payload: "{}" });
        store.next();
        store.complete(id);
      }
      store.close();
      const database = new Database(databasePath, { readonly: true, strict: true });
      expect(
        database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM webhook_deliveries")
          .get(),
      ).toEqual({ count: 1 });
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("logs redacted delivery failures", async () => {
    const store = new MemoryDeliveryStore();
    const messages: string[] = [];
    store.enqueue({ id: "delivery-1", host: "gitlab", payload: "{}" });
    await processNextWebhookDelivery({
      store,
      run: async () => {
        throw new Error("token=glpat-secret-value");
      },
      log: (message) => messages.push(message),
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("delivery-1");
    expect(messages[0]).not.toContain("glpat-secret-value");
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
