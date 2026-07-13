import { describe, expect, it } from "bun:test";
import { retryCodeHostOperation } from "../retry.js";

describe("code host retry policy", () => {
  it("reconciles an accepted write before retrying", async () => {
    let writes = 0;
    let published: { id: string } | undefined;

    const result = await retryCodeHostOperation({
      operation: async () => {
        writes += 1;
        published = { id: "comment-1" };
        throw retryableError(503);
      },
      reconcile: async () => published,
      sleep: async () => {
        throw new Error("reconciled writes must not sleep");
      },
    });

    expect(result).toEqual({ id: "comment-1" });
    expect(writes).toBe(1);
  });

  it("retries a write only after reconciliation proves it is missing", async () => {
    const waits: number[] = [];
    let writes = 0;

    const result = await retryCodeHostOperation({
      operation: async () => {
        writes += 1;
        if (writes === 1) throw retryableError(503, { "retry-after": "2" });
        return { id: "comment-1" };
      },
      reconcile: async () => undefined,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    expect(result).toEqual({ id: "comment-1" });
    expect(writes).toBe(2);
    expect(waits).toEqual([2_000]);
  });

  it("does not retry unsafe writes without reconciliation", async () => {
    let writes = 0;

    await expect(
      retryCodeHostOperation({
        operation: async () => {
          writes += 1;
          throw retryableError(503);
        },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(writes).toBe(1);
  });
});

function retryableError(status: number, headers: Record<string, string> = {}) {
  return Object.assign(new Error(`request failed with ${status}`), { status, headers });
}
