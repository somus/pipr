import { describe, expect, it } from "bun:test";
import type { ReviewFinding } from "@usepipr/sdk";
import { createOutputState, recordFindingFacets } from "../task-output.js";

describe("recordFindingFacets", () => {
  it("keeps facets for distinct findings on the same lines", () => {
    const state = createOutputState();
    const location = {
      path: "src/a.ts",
      rangeId: "rng_1",
      side: "RIGHT",
      startLine: 3,
      endLine: 3,
    };
    const findings = [
      { ...location, body: "SQL injection.", severity: "high" },
      { ...location, body: "Rename this variable.", severity: "low" },
    ] as unknown as ReviewFinding[];

    recordFindingFacets(state, findings, { severity: ["high", "low"] });

    expect([...state.findingFacets.values()]).toEqual([{ severity: "high" }, { severity: "low" }]);
  });
});
