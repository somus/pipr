import { describe, expect, it } from "bun:test";
import type { ReviewFinding } from "@usepipr/sdk";
import {
  createCheckHandle,
  createOutputState,
  findingAttribution,
  mergeTaskOutputs,
  recordAgentFindingProvenance,
  recordFindingFacets,
} from "../task-output.js";

describe("finding attribution", () => {
  const location = {
    path: "src/a.ts",
    rangeId: "rng_1",
    side: "RIGHT",
    startLine: 3,
    endLine: 3,
  };

  it("keeps facets for distinct findings on the same lines", () => {
    const state = createOutputState();
    const findings = [
      { ...location, body: "SQL injection.", severity: "high" },
      { ...location, body: "Rename this variable.", severity: "low" },
    ] as unknown as ReviewFinding[];

    recordFindingFacets(state, findings, { severity: ["high", "low"] });

    expect(findings.map((finding) => findingAttribution(state, finding).facets)).toEqual([
      { severity: "high" },
      { severity: "low" },
    ]);
  });

  it("remembers the producing agent and model for copies of a finding across tasks", () => {
    const security = createOutputState();
    const style = createOutputState();
    const finding = { ...location, body: "SQL injection.", severity: "high" } as ReviewFinding;
    recordAgentFindingProvenance(
      security,
      { summary: { body: "Found one." }, inlineFindings: [finding] },
      { agent: "security", model: "deepseek-v4" },
    );
    recordFindingFacets(security, [finding], { severity: ["high", "low"] });

    const merged = mergeTaskOutputs([
      { taskName: "security", output: security },
      { taskName: "style", output: style },
    ]);

    expect(findingAttribution(merged, { ...finding, rangeId: "rng_canonical" })).toEqual({
      agent: "security",
      model: "deepseek-v4",
      facets: { severity: "high" },
    });
    expect(findingAttribution(merged, { ...finding, body: "Other." })).toEqual({ facets: {} });
    expect(Object.keys(finding)).not.toContain("agent");
  });
});

type Finding = ReviewFinding & { severity?: string };

function finding(line: number, patch: Partial<Finding> = {}): Finding {
  return {
    body: `Finding ${line}`,
    path: "src/a.ts",
    rangeId: "rng_1",
    side: "RIGHT",
    startLine: line,
    endLine: line,
    ...patch,
  };
}

describe("ctx.check.gate", () => {
  it("fails on matching facet values and passes otherwise", () => {
    const failing = createOutputState();
    const result = createCheckHandle(failing).gate(
      [finding(1, { severity: "high" }), finding(2, { severity: "low" })],
      { failOn: { severity: ["critical", "high"] } },
    );
    expect(result.passed).toBe(false);
    expect(result.blocking.map((item) => item.startLine)).toEqual([1]);
    expect(failing.check).toEqual({ conclusion: "failure", summary: "1 blocking finding." });

    const passing = createOutputState();
    createCheckHandle(passing).gate([finding(2, { severity: "low" })], {
      failOn: (item) => item.severity === "critical",
      summary: (blocking) => `${blocking.length} critical`,
    });
    expect(passing.check).toEqual({ conclusion: "success", summary: "0 critical" });
  });
});
