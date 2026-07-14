import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createCodeHostHttpClient, createCodeHostSuccessThrottle } from "../http.js";

describe("code host HTTP client", () => {
  it("aborts requests that exceed the configured timeout", async () => {
    const client = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      requestTimeoutMilliseconds: 1,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    });

    await expect(client.json("items", z.unknown())).rejects.toThrow("timed out");
  });

  it("retries throttled reads using Retry-After", async () => {
    const waits: number[] = [];
    const responses = [
      new Response("busy", { status: 429, headers: { "Retry-After": "2" } }),
      Response.json({ value: "ok" }),
    ];
    const client = createCodeHostHttpClient({
      baseUrl: "https://example.test/api/",
      fetch: async () => {
        const response = responses.shift();
        if (!response) {
          throw new Error("No test response remains");
        }
        return response;
      },
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(client.json("items", z.object({ value: z.string() }))).resolves.toEqual({
      value: "ok",
    });
    expect(waits).toEqual([2_000]);
  });

  it("retries transient server failures and stops at the retry limit", async () => {
    let recoveringCalls = 0;
    const recovering = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () =>
        ++recoveringCalls === 1
          ? new Response("unavailable", { status: 503 })
          : Response.json({ value: "ok" }),
      sleep: async () => {},
    });
    await expect(recovering.json("items", z.object({ value: z.string() }))).resolves.toEqual({
      value: "ok",
    });

    let exhaustedCalls = 0;
    const exhausted = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () => {
        exhaustedCalls += 1;
        return new Response("unavailable", { status: 503 });
      },
      sleep: async () => {},
      maxRetries: 2,
    });
    await expect(exhausted.json("items", z.unknown())).rejects.toThrow("503");
    expect(exhaustedCalls).toBe(3);
  });

  it("does not retry unsafe writes", async () => {
    let calls = 0;
    const client = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () => {
        calls += 1;
        return new Response("busy", { status: 429, headers: { "Retry-After": "1" } });
      },
      sleep: async () => {},
    });

    await expect(client.json("items", z.unknown(), { method: "POST" })).rejects.toThrow("429");
    expect(calls).toBe(1);
  });

  it("delays the request after a successful response carrying Retry-After", async () => {
    const waits: number[] = [];
    const client = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () => Response.json({ value: "ok" }, { headers: { "Retry-After": "1" } }),
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await client.json("first", z.object({ value: z.string() }));
    await client.json("second", z.object({ value: z.string() }));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(900);
    expect(waits[0]).toBeLessThanOrEqual(1_000);
  });

  it("checks a shared success throttle before retry attempts", async () => {
    const waits: number[] = [];
    const successThrottle = createCodeHostSuccessThrottle(async (milliseconds) => {
      waits.push(milliseconds);
    });
    let releaseRetry: (() => void) | undefined;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let markFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      markFirstAttempt = resolve;
    });
    let retryCalls = 0;
    const retryingClient = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () => {
        retryCalls += 1;
        if (retryCalls === 1) {
          markFirstAttempt?.();
          return new Response("unavailable", { status: 503 });
        }
        return Response.json({ value: "retried" });
      },
      sleep: async () => retryGate,
      successThrottle,
    });
    const throttlingClient = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () => Response.json({ value: "throttled" }, { headers: { "Retry-After": "2" } }),
      successThrottle,
    });

    const retry = retryingClient.json("retry", z.object({ value: z.string() }));
    await firstAttempt;
    await throttlingClient.json("throttle", z.object({ value: z.string() }));
    releaseRetry?.();

    await expect(retry).resolves.toEqual({ value: "retried" });
    expect(retryCalls).toBe(2);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(1_900);
    expect(waits[0]).toBeLessThanOrEqual(2_000);
  });

  it("extends an in-flight wait when a later response increases Retry-After", async () => {
    const waits: number[] = [];
    const releases: Array<() => void> = [];
    const successThrottle = createCodeHostSuccessThrottle(
      (milliseconds) =>
        new Promise<void>((resolve) => {
          waits.push(milliseconds);
          releases.push(resolve);
        }),
    );

    successThrottle.update("1");
    const waiting = successThrottle.wait();
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(900);
    expect(waits[0]).toBeLessThanOrEqual(1_000);

    successThrottle.update("2");
    releases.shift()?.();
    await Promise.resolve();

    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(1_900);
    releases.shift()?.();
    await waiting;
  });

  it("redacts credentials and bounds error response text", async () => {
    const secret = "glpat-abcdefghijklmnopqrstuvwxyz";
    const unregistered = "model-api_key-abcdefghijklmnop";
    const client = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      headers: { Authorization: `Bearer ${secret}` },
      fetch: async () =>
        new Response(`token=${secret} ${unregistered} ${"x".repeat(2_000)}`, { status: 403 }),
    });

    const error = (await client.json("private", z.unknown()).catch((caught) => caught)) as Error;
    expect(error.message).not.toContain(secret);
    expect(error.message).toContain(unregistered);
    expect(error.message.length).toBeLessThan(1_400);
  });

  it("exposes response status without coupling callers to error message text", async () => {
    const client = createCodeHostHttpClient({
      baseUrl: "https://example.test/",
      fetch: async () => new Response("missing", { status: 404 }),
    });

    const error = await client.json("missing", z.unknown()).catch((caught) => caught);

    expect(error).toMatchObject({ status: 404 });
  });
});
