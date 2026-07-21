import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiprResult } from "@usepipr/sdk";
import { createCodeHostWebhookProtocol } from "../../hosts/webhook.js";
import {
  createWebhookIngress,
  createWebhookQueueProcessor,
  processNextWebhookDelivery,
  readWebhookDeliveryStatus,
  runWebhookDelivery,
  runWebhookServer,
  SqliteWebhookDeliveryStore,
  type WebhookDelivery,
  type WebhookDeliveryStore,
} from "../webhook-server.js";

const ignoredPiprResult = {
  formatVersion: 2,
  kind: "ignored",
  reason: "test",
} as const satisfies PiprResult;
const errorPiprResult = {
  formatVersion: 2,
  kind: "error",
  message: "Pipr failed; see the Action log for details.",
} as const satisfies PiprResult;
const commandResponsePiprResult = {
  formatVersion: 2,
  kind: "command-response",
  run: {
    id: "run-webhook",
    trigger: "command",
    baseSha: "base",
    headSha: "head",
    tasks: ["ask"],
    durationMs: 10,
    models: ["deepseek-chat"],
    agentRuns: 1,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
    usageStatus: "complete",
  },
  mainComment: "Completed.",
  publication: { state: "completed", action: "created" },
} as const satisfies PiprResult;

describe("webhook runner", () => {
  it("applies environment-only run-store settings before accepting traffic", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-retention-"));
    const runStore = path.join(root, "runs");
    const partial = path.join(runStore, "a".repeat(32));
    await mkdir(partial, { recursive: true });
    await writeFile(path.join(partial, "partial.log"), "sensitive".repeat(100));
    const previousFetch = globalThis.fetch;
    const previousSignalCount = process.listenerCount("SIGTERM");
    globalThis.fetch = (async () =>
      Response.json({ id: 42, path_with_namespace: "group/project" })) as unknown as typeof fetch;
    try {
      await expect(
        runWebhookServer({
          host: "gitlab",
          workspace: root,
          configDir: ".pipr",
          databasePath: path.join(root, "invalid.sqlite"),
          expectedRepository: "group/project",
          secret: "webhook-secret",
          hostname: "127.0.0.1",
          port: 0,
          env: {
            GITLAB_TOKEN: "token",
            PIPR_RUN_STORE_DIR: runStore,
            PIPR_RUN_RETENTION_DAYS: "0",
          },
        }),
      ).rejects.toThrow("positive integer");

      const server = runWebhookServer({
        host: "gitlab",
        workspace: root,
        configDir: ".pipr",
        databasePath: path.join(root, "deliveries.sqlite"),
        expectedRepository: "group/project",
        secret: "webhook-secret",
        hostname: "127.0.0.1",
        port: 0,
        env: {
          GITLAB_TOKEN: "token",
          PIPR_RUN_STORE_DIR: runStore,
          PIPR_RUN_RETENTION_DAYS: "14",
          PIPR_RUN_MAX_BYTES: "1",
        },
      });
      const stop = await waitForNewSignalListener("SIGTERM", previousSignalCount);
      await expect(access(partial)).rejects.toThrow();
      stop();
      await server;
    } finally {
      globalThis.fetch = previousFetch;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports HTTP health without requiring webhook authentication", async () => {
    const store = new MemoryDeliveryStore();
    const ingress = createWebhookIngress({
      host: "gitlab",
      secret: "webhook-secret",
      expectedRepository: { id: "42", path: "group/project" },
      store,
    });

    const response = await ingress(new Request("http://localhost/healthz"));
    const headResponse = await ingress(new Request("http://localhost/healthz", { method: "HEAD" }));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(headResponse.status).toBe(200);
    expect(store.deliveries).toHaveLength(0);
  });

  it("waits for the active delivery before completing shutdown", async () => {
    const store = new MemoryDeliveryStore();
    store.enqueue({ id: "delivery-1", host: "gitlab", payload: "{}" });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let runs = 0;
    const processor = createWebhookQueueProcessor({
      store,
      run: async () => {
        runs += 1;
        started.resolve();
        await release.promise;
        return { kind: "ignored", reason: "test" };
      },
    });

    const processing = processor.run();
    await started.promise;
    let stopped = false;
    const stopping = processor.stop().then(() => {
      stopped = true;
    });
    await Bun.sleep(0);
    expect(stopped).toBe(false);

    release.resolve();
    await Promise.all([processing, stopping]);
    expect(store.completed).toEqual(["delivery-1"]);
    await processor.run();
    expect(runs).toBe(1);
  });

  it("contains transient store failures and retries on the next processor run", async () => {
    const backingStore = new MemoryDeliveryStore();
    backingStore.enqueue({ id: "delivery-1", host: "gitlab", payload: "{}" });
    let failNext = true;
    const store: WebhookDeliveryStore = {
      enqueue: (delivery) => backingStore.enqueue(delivery),
      next() {
        if (failNext) {
          failNext = false;
          throw new Error("token=glpat-secret-value");
        }
        return backingStore.next();
      },
      complete: (id, result) => backingStore.complete(id, result),
      fail: (id, error) => backingStore.fail(id, error),
    };
    const messages: string[] = [];
    const processor = createWebhookQueueProcessor({
      store,
      run: async () => ({ kind: "ignored", reason: "test" }),
      log: (message) => messages.push(message),
    });

    await expect(processor.run()).resolves.toBeUndefined();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("webhook queue processing failed");
    expect(messages[0]).not.toContain("glpat-secret-value");

    await processor.run();
    expect(backingStore.completed).toEqual(["delivery-1"]);
  });

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
    expect(
      (
        await ingress(
          new Request("http://localhost/webhook", {
            method: "POST",
            headers: {
              "X-Gitlab-Token": "webhook-secret",
              "X-Gitlab-Webhook-UUID": "missing-project",
            },
            body: "{}",
          }),
        )
      ).status,
    ).toBe(403);
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

  it("returns retry guidance when the durable queue is full", async () => {
    const ingress = createWebhookIngress({
      host: "gitlab",
      secret: "webhook-secret",
      expectedRepository: { id: "42", path: "group/project" },
      store: { enqueue: () => "full", next: () => undefined, complete() {}, fail() {} },
    });
    const response = await ingress(
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "X-Gitlab-Token": "webhook-secret",
          "X-Gitlab-Webhook-UUID": "full-queue",
        },
        body: '{"project":{"id":42,"path_with_namespace":"group/project"}}',
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
  });

  it("authenticates and binds Azure service-hook deliveries to one subscription and repository", async () => {
    const store = new MemoryDeliveryStore();
    const ingress = createWebhookIngress({
      host: "azure-devops",
      secret: "webhook-secret",
      expectedRepository: {
        organization: "org",
        projectId: "project-id",
        repositoryId: "repo-id",
        subscriptionId: "subscription-1",
      },
      store,
    });
    const payload = (overrides: Record<string, unknown> = {}) =>
      JSON.stringify({
        id: "event-1",
        eventType: "git.pullrequest.updated",
        subscriptionId: "subscription-1",
        notificationId: 4,
        resource: {
          pullRequestId: 7,
          repository: { id: "repo-id", project: { id: "project-id" } },
        },
        resourceContainers: {
          account: { baseUrl: "https://dev.azure.com/org/" },
          project: { id: "project-id" },
        },
        ...overrides,
      });
    const request = (body: string, secret = "webhook-secret") =>
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { "X-Pipr-Webhook-Secret": secret },
        body,
      });

    const basicRequest = (authorization: string) =>
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: { Authorization: authorization },
        body: payload({ id: `basic-${authorization.length}` }),
      });

    expect((await ingress(request(payload()))).status).toBe(202);
    expect((await ingress(request(payload()))).status).toBe(200);
    expect(
      (
        await ingress(
          basicRequest(`Basic ${Buffer.from("azure:webhook-secret").toString("base64")}`),
        )
      ).status,
    ).toBe(202);
    for (const authorization of [
      `Basic ${Buffer.from("azure:wrong").toString("base64")}`,
      `Basic ${Buffer.from("azure").toString("base64")}`,
      "Basic %%%",
    ]) {
      expect((await ingress(basicRequest(authorization))).status).toBe(401);
    }
    expect(store.deliveries[0]?.id).toBe("azure-devops:subscription-1:event-1:4");
    expect((await ingress(request(payload(), "wrong"))).status).toBe(401);
    expect(
      (await ingress(request(payload({ subscriptionId: "other-subscription", id: "event-2" }))))
        .status,
    ).toBe(403);
    expect(
      (
        await ingress(
          request(
            payload({
              id: "event-3",
              resource: {
                pullRequestId: 7,
                repository: { id: "other-repo", project: { id: "project-id" } },
              },
            }),
          ),
        )
      ).status,
    ).toBe(403);
  });

  it("validates Bitbucket HMAC signatures and repository binding", async () => {
    const store = new MemoryDeliveryStore();
    const ingress = createWebhookIngress({
      host: "bitbucket",
      secret: "webhook-secret",
      expectedRepository: { uuid: "{repo}", fullName: "workspace/repository" },
      store,
    });
    const payload = JSON.stringify({
      repository: { uuid: "{repo}", full_name: "workspace/repository" },
      pullrequest: { id: 7 },
    });
    const request = (body: string, secret = "webhook-secret", attempt = "1") =>
      new Request("http://localhost/webhook", {
        method: "POST",
        headers: {
          "X-Hub-Signature": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
          "X-Hook-UUID": "hook-1",
          "X-Request-UUID": "request-1",
          "X-Attempt-Number": attempt,
          "X-Event-Key": "pullrequest:updated",
        },
        body,
      });

    expect((await ingress(request(payload))).status).toBe(202);
    expect((await ingress(request(payload, "webhook-secret", "2"))).status).toBe(200);
    expect(store.deliveries[0]?.id).toStartWith("bitbucket:hook-1:request-1:");
    expect(store.deliveries[0]?.eventName).toBe("pullrequest:updated");
    expect((await ingress(request(payload, "wrong"))).status).toBe(401);
    const wrongRepository = payload.replace("{repo}", "{other}");
    expect((await ingress(request(wrongRepository))).status).toBe(403);
  });

  it("rejects a Bitbucket webhook repository argument that disagrees with the environment", async () => {
    const protocol = createCodeHostWebhookProtocol("bitbucket");
    await expect(
      protocol.resolveExpectedRepository(
        {
          BITBUCKET_WORKSPACE: "workspace",
          BITBUCKET_REPO_SLUG: "repository",
          BITBUCKET_EMAIL: "pipr@example.com",
          BITBUCKET_API_TOKEN: "token",
        },
        "other-repository",
      ),
    ).rejects.toThrow("does not match BITBUCKET_REPO_SLUG");
  });

  it("rejects unsupported webhook hosts at the runtime boundary", () => {
    expect(() => createCodeHostWebhookProtocol("unknown" as never)).toThrow(
      "Unsupported webhook host: unknown",
    );
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
      store.complete("one", ignoredPiprResult);
      expect(store.enqueue({ id: "three", host: "gitlab", payload: "x".repeat(101) })).toBe("full");
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not count the active delivery against the pending queue budget", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    try {
      const store = new SqliteWebhookDeliveryStore(path.join(root, "deliveries.sqlite"), {
        maxPendingDeliveries: 1,
      });
      expect(store.enqueue({ id: "processing", host: "gitlab", payload: "{}" })).toBe("created");
      expect(store.next()?.id).toBe("processing");
      expect(store.enqueue({ id: "pending", host: "gitlab", payload: "{}" })).toBe("created");
      expect(store.enqueue({ id: "overflow", host: "gitlab", payload: "{}" })).toBe("full");
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs queued deliveries once and records failures without exposing payloads", async () => {
    const store = new MemoryDeliveryStore();
    store.enqueue({ id: "delivery-1", host: "gitlab", payload: '{"safe":true}' });
    const runs: WebhookDelivery[] = [];

    await processNextWebhookDelivery({
      store,
      run: async (delivery) => {
        runs.push(delivery);
        return { kind: "ignored", reason: "test" };
      },
    });
    expect(runs).toHaveLength(1);
    expect(store.completed).toEqual(["delivery-1"]);

    store.enqueue({ id: "delivery-2", host: "gitlab", payload: '{"secret":"not logged"}' });
    await processNextWebhookDelivery({
      store,
      run: async () => {
        throw new Error("provider failed");
      },
    });
    expect(store.failures).toEqual([{ id: "delivery-2", error: errorPiprResult }]);
  });

  it("writes one temporary event, selects GitLab, and cleans up after host-run execution", async () => {
    const observedPaths: string[] = [];
    await runWebhookDelivery(
      { id: "delivery-1", host: "gitlab", payload: '{"project":{"id":42}}' },
      {
        workspace: "/workspace",
        configDir: ".pipr",
        env: { SAFE: "value" },
        runStoreDirectory: "/runs",
      },
      async (options) => {
        observedPaths.push(options.eventPath ?? "");
        expect(await Bun.file(options.eventPath ?? "").text()).toContain('"id":42');
        expect(options).toMatchObject({
          rootDir: "/workspace",
          configDir: ".pipr",
          host: "gitlab",
          env: { SAFE: "value", PIPR_CODE_HOST: "gitlab", PIPR_RUN_STORE_DIR: "/runs" },
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

  it("translates persisted Bitbucket event names through the host protocol", async () => {
    await runWebhookDelivery(
      {
        id: "delivery-1",
        host: "bitbucket",
        payload: "{}",
        eventName: "pullrequest:updated",
      },
      { workspace: "/workspace", configDir: ".pipr", env: {} },
      async (options) => {
        expect(options.env?.BITBUCKET_EVENT_KEY).toBe("pullrequest:updated");
        return { kind: "ignored", reason: "test" } as const;
      },
    );
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
      second.close();

      const third = new SqliteWebhookDeliveryStore(databasePath);
      expect(third.next()).toEqual({ id: "delivery-1", host: "gitlab", payload: "{}" });
      third.complete("delivery-1", ignoredPiprResult);
      third.close();

      const fourth = new SqliteWebhookDeliveryStore(databasePath);
      expect(fourth.next()).toBeUndefined();
      expect(fourth.enqueue({ id: "delivery-1", host: "gitlab", payload: "{}" })).toBe("duplicate");
      fourth.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restricts persisted webhook results to the service account", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath);
      expect((await stat(databasePath)).mode & 0o777).toBe(0o600);
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists schema-valid V2 outcomes without raw failure text", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath);
      store.enqueue({ id: "success", host: "gitlab", payload: "{}" });
      await processNextWebhookDelivery({
        store,
        run: async () => ({ kind: "ignored", reason: "unsupported event" }),
      });
      store.enqueue({ id: "failure", host: "gitlab", payload: "{}" });
      await processNextWebhookDelivery({
        store,
        run: async () => {
          throw new Error("token=private-provider-secret");
        },
      });
      store.close();

      const database = new Database(databasePath, { readonly: true, strict: true });
      const rows = database
        .query<{ id: string; resultKind: string; resultJson: string; error: string | null }, []>(
          "SELECT id, result_kind AS resultKind, result_json AS resultJson, error FROM webhook_deliveries ORDER BY id",
        )
        .all();
      expect(rows.map((row) => ({ ...row, resultJson: JSON.parse(row.resultJson) }))).toEqual([
        {
          id: "failure",
          resultKind: "error",
          resultJson: {
            formatVersion: 2,
            kind: "error",
            message: "Pipr failed; see the Action log for details.",
          },
          error: "Pipr failed; see the Action log for details.",
        },
        {
          id: "success",
          resultKind: "ignored",
          resultJson: { formatVersion: 2, kind: "ignored", reason: "unsupported event" },
          error: null,
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain("private-provider-secret");
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds result bodies and clears prior attempt results when retrying", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath, {
        maxResultBytes: 80,
        maxRetainedResultBytes: 120,
      });
      store.enqueue({ id: "large", host: "gitlab", payload: "{}" });
      store.next();
      store.complete("large", {
        formatVersion: 2,
        kind: "ignored",
        reason: "x".repeat(200),
      });
      store.enqueue({ id: "retry", host: "gitlab", payload: "{}" });
      store.next();
      store.fail("retry", errorPiprResult);

      const database = new Database(databasePath, { strict: true });
      expect(
        database
          .query<{ resultJson: string | null; reason: string | null }, []>(
            "SELECT result_json AS resultJson, result_omitted_reason AS reason FROM webhook_deliveries WHERE id = 'large'",
          )
          .get(),
      ).toEqual({ resultJson: null, reason: "size-limit" });
      expect(store.next()?.id).toBe("retry");
      expect(
        database
          .query<{ kind: string | null; resultJson: string | null }, []>(
            "SELECT result_kind AS kind, result_json AS resultJson FROM webhook_deliveries WHERE id = 'retry'",
          )
          .get(),
      ).toEqual({ kind: null, resultJson: null });
      database.close();
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("evicts the oldest result bodies when aggregate retention is exceeded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath, {
        maxResultBytes: 1_024,
        maxRetainedResultBytes: 150,
      });
      for (const id of ["a-oldest", "z-newest"]) {
        store.enqueue({ id, host: "gitlab", payload: "{}" });
        store.next();
        store.complete(id, {
          formatVersion: 2,
          kind: "ignored",
          reason: `${id}-${"x".repeat(45)}`,
        });
      }
      store.close();

      const database = new Database(databasePath, { readonly: true, strict: true });
      expect(
        database
          .query<{ id: string; resultJson: string | null; reason: string | null }, []>(
            "SELECT id, result_json AS resultJson, result_omitted_reason AS reason FROM webhook_deliveries ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "a-oldest", resultJson: null, reason: "retention" },
        { id: "z-newest", resultJson: expect.any(String), reason: null },
      ]);
      database.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases queue capacity after recovering an interrupted final attempt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const store = new SqliteWebhookDeliveryStore(databasePath, { maxPendingDeliveries: 1 });
        if (attempt === 0)
          expect(store.enqueue({ id: "interrupted", host: "gitlab", payload: "{}" })).toBe(
            "created",
          );
        expect(store.next()?.id).toBe("interrupted");
        store.close();
      }

      const recovered = new SqliteWebhookDeliveryStore(databasePath, { maxPendingDeliveries: 1 });
      expect(recovered.enqueue({ id: "next", host: "gitlab", payload: "{}" })).toBe("created");
      recovered.close();
      expect(readWebhookDeliveryStatus(databasePath, 2)).toContainEqual(
        expect.objectContaining({
          id: "interrupted",
          status: "failed",
          attempts: 3,
          resultKind: "error",
          result: errorPiprResult,
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("projects stored run ids and omission reasons through webhook status", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const store = new SqliteWebhookDeliveryStore(databasePath);
      store.enqueue({ id: "run-result", host: "gitlab", payload: "{}" });
      store.next();
      store.complete("run-result", commandResponsePiprResult);
      store.close();

      const database = new Database(databasePath, { strict: true });
      database.exec(`
        INSERT INTO webhook_deliveries
          (id, host, status, attempts, result_kind, result_omitted_reason)
        VALUES
          ('size-limited', 'gitlab', 'completed', 1, 'review', 'size-limit'),
          ('retained', 'gitlab', 'completed', 1, 'review', 'retention');
      `);
      database.close();

      expect(readWebhookDeliveryStatus(databasePath, 3)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "run-result",
            runId: "run-webhook",
            resultKind: "command-response",
            result: commandResponsePiprResult,
          }),
          expect.objectContaining({
            id: "size-limited",
            resultOmittedReason: "size-limit",
          }),
          expect.objectContaining({ id: "retained", resultOmittedReason: "retention" }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("migrates legacy queues and preserves provider event names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pipr-webhook-store-"));
    const databasePath = path.join(root, "deliveries.sqlite");
    try {
      const legacy = new Database(databasePath, { create: true, strict: true });
      legacy.exec(`
        CREATE TABLE webhook_deliveries (
          id TEXT PRIMARY KEY,
          host TEXT NOT NULL,
          payload TEXT,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );
        INSERT INTO webhook_deliveries (id, host, payload, status)
        VALUES ('legacy', 'gitlab', '{}', 'pending');
      `);
      legacy.close();

      const store = new SqliteWebhookDeliveryStore(databasePath);
      expect(store.next()).toEqual({ id: "legacy", host: "gitlab", payload: "{}" });
      store.complete("legacy", ignoredPiprResult);
      expect(
        store.enqueue({
          id: "bitbucket",
          host: "bitbucket",
          payload: "{}",
          eventName: "pullrequest:updated",
        }),
      ).toBe("created");
      expect(store.next()).toEqual({
        id: "bitbucket",
        host: "bitbucket",
        payload: "{}",
        eventName: "pullrequest:updated",
      });
      store.close();
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
        store.fail("delivery-1", errorPiprResult);
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
        store.complete(id, ignoredPiprResult);
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

  it("logs bounded delivery failures without rewriting stored errors", async () => {
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
    expect(store.failures).toEqual([{ id: "delivery-1", error: errorPiprResult }]);
  });
});

async function waitForNewSignalListener(
  signal: "SIGTERM",
  previousCount: number,
): Promise<() => void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const listeners = process.listeners(signal);
    const listener = listeners.length > previousCount ? listeners.at(-1) : undefined;
    if (listener) return () => listener(signal);
    await Bun.sleep(10);
  }
  throw new Error(`Webhook server did not register ${signal}`);
}

class MemoryDeliveryStore implements WebhookDeliveryStore {
  deliveries: WebhookDelivery[] = [];
  completed: string[] = [];
  failures: Array<{ id: string; error: PiprResult }> = [];
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
  complete(id: string, _result: PiprResult) {
    this.completed.push(id);
  }
  fail(id: string, error: PiprResult) {
    this.failures.push({ id, error });
  }
}
