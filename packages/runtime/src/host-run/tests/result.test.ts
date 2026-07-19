import { describe, expect, it } from "bun:test";
import { parsePiprResult } from "@usepipr/sdk";
import { toPiprErrorResult, toPiprResult } from "../result.js";

describe("Pipr Result conversion", () => {
  it("projects host outcomes into schema-validated V2 results", () => {
    const result = toPiprResult({
      source: "host",
      result: { kind: "ignored", reason: "unsupported event" },
    });

    expect(parsePiprResult(result)).toEqual({
      formatVersion: 2,
      kind: "ignored",
      reason: "unsupported event",
    });
  });

  it("never exposes raw thrown errors", () => {
    const result = toPiprErrorResult(new Error("provider-secret"));

    expect(result).toEqual({
      formatVersion: 2,
      kind: "error",
      message: "Pipr failed; see logs for details.",
    });
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });
});
