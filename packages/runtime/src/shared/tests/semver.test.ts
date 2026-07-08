import { describe, expect, it } from "bun:test";
import { compareStableSemver, isStableSemver } from "../semver.js";

describe("stable semver", () => {
  it("accepts exact stable versions", () => {
    expect(isStableSemver("0.3.3")).toBe(true);
    expect(isStableSemver("10.20.30")).toBe(true);
  });

  it("rejects non-exact, prerelease, and leading-zero versions", () => {
    for (const version of ["^0.3.3", "0.3.3-beta.1", "01.0.0", "1.02.0", "1.0.03"]) {
      expect(isStableSemver(version)).toBe(false);
    }
  });

  it("compares stable versions numerically", () => {
    expect(compareStableSemver("0.3.3", "0.3.3")).toBe(0);
    expect(compareStableSemver("0.3.4", "0.3.3")).toBeGreaterThan(0);
    expect(compareStableSemver("0.2.9", "0.3.0")).toBeLessThan(0);
    expect(compareStableSemver("10.0.0", "2.0.0")).toBeGreaterThan(0);
  });

  it("refuses to compare invalid stable versions", () => {
    expect(() => compareStableSemver("01.0.0", "1.0.0")).toThrow(
      "cannot compare non-stable semver versions: 01.0.0, 1.0.0",
    );
  });
});
