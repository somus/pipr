import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import { openBunSqliteDatabase, openBunSqliteStorage } from "../bun-sqlite.js";

registerStorageConformance({ describe, expect, it }, "bun:sqlite storage", async (use) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-durable-store-"));
  const storage = await openBunSqliteStorage(path.join(directory, "store.sqlite"));
  try {
    await use(storage);
  } finally {
    await storage.close(BACKGROUND_CONTEXT);
    await rm(directory, { recursive: true, force: true });
  }
});

describe("bun:sqlite database facade", () => {
  it("rolls back a failed transaction and rejects with the callback error", async () => {
    const database = await openBunSqliteDatabase(":memory:");
    try {
      await database.exec("CREATE TABLE example (value TEXT)");
      await expect(
        database.transaction(async (transaction) => {
          await transaction.run("INSERT INTO example (value) VALUES (?)", "discarded");
          throw new Error("callback failed");
        }),
      ).rejects.toThrow("callback failed");
      expect(await database.all("SELECT value FROM example")).toEqual([]);
    } finally {
      await database.close();
    }
  });

  it("queues unrelated operations until the open transaction settles", async () => {
    const database = await openBunSqliteDatabase(":memory:");
    try {
      await database.exec("CREATE TABLE example (value TEXT)");
      const order: string[] = [];
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const transaction = database.transaction(async (handle) => {
        await handle.run("INSERT INTO example (value) VALUES (?)", "inside");
        await gate;
        order.push("transaction");
      });
      const outside = database.run("INSERT INTO example (value) VALUES (?)", "outside").then(() => {
        order.push("outside");
      });
      release();
      await Promise.all([transaction, outside]);
      expect(order).toEqual(["transaction", "outside"]);
    } finally {
      await database.close();
    }
  });

  it("rejects work through an expired transaction handle", async () => {
    const database = await openBunSqliteDatabase(":memory:");
    try {
      let leaked: Parameters<Parameters<typeof database.transaction>[0]>[0] | undefined;
      await database.transaction(async (handle) => {
        leaked = handle;
      });
      await expect(leaked?.exec("SELECT 1") ?? Promise.resolve()).rejects.toThrow(
        "no longer active",
      );
    } finally {
      await database.close();
    }
  });
});
