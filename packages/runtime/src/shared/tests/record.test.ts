import { describe, expect, it } from "bun:test";
import { isRecord } from "../record.js";

describe("isRecord", () => {
  it("accepts non-null objects other than arrays", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date())).toBe(true);
  });

  it("rejects null, arrays, and primitives", () => {
    for (const value of [null, [], "value", 1, true, undefined]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});
