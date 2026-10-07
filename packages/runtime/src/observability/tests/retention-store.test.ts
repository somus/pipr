import { describe, expect, it } from "bun:test";
import path from "node:path";
import { resolveRunStoreDirectory } from "../retention-store.js";

describe("resolveRunStoreDirectory", () => {
  it("prefers an explicit directory, then PIPR_RUN_STORE_DIR", () => {
    const env = { PIPR_RUN_STORE_DIR: "/env/runs" };

    expect(resolveRunStoreDirectory({ configured: "/flag/runs", env, mode: "webhook" })).toBe(
      "/flag/runs",
    );
    expect(resolveRunStoreDirectory({ env, mode: "workspace", rootDir: "/repo" })).toBe(
      "/env/runs",
    );
  });

  it("defaults per mode when nothing is configured", () => {
    expect(resolveRunStoreDirectory({ env: {}, mode: "workspace", rootDir: "/repo" })).toBe(
      path.join("/repo", ".pipr-runs"),
    );
    expect(resolveRunStoreDirectory({ env: {}, mode: "webhook" })).toBe("/var/lib/pipr/runs");
  });
});
