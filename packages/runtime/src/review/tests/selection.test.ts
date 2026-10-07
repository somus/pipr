import { describe, expect, it } from "bun:test";
import type { ReviewFinding } from "@usepipr/sdk";
import { capDropReason, selectRankedFindings } from "../selection.js";
import { createCheckHandle, createOutputState } from "../task/task-output.js";

type Finding = ReviewFinding & { severity?: string; category?: string };

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

const facets = {
  severity: ["critical", "high", "low"],
  category: ["security", "bug"],
} as const;

describe("selectRankedFindings", () => {
  it("ranks by facet declaration order, then by input order", () => {
    const selection = selectRankedFindings(
      [
        finding(1, { severity: "low" }),
        finding(2, { severity: "critical", category: "bug" }),
        finding(3, { severity: "critical", category: "security" }),
        finding(4),
      ],
      { facets },
    );
    expect(selection.findings.map((item) => item.startLine)).toEqual([3, 2, 1, 4]);
  });

  it("honors an explicit rank order", () => {
    const selection = selectRankedFindings(
      [
        finding(1, { severity: "critical", category: "bug" }),
        finding(2, { severity: "low", category: "security" }),
      ],
      { facets, rank: ["category"] },
    );
    expect(selection.findings.map((item) => item.startLine)).toEqual([2, 1]);
  });

  it("keeps distinct findings at one location and caps lower-ranked findings", () => {
    const selection = selectRankedFindings(
      [
        finding(1, { severity: "low", body: "weak" }),
        finding(1, { severity: "high", body: "strong" }),
        finding(2, { severity: "high" }),
        finding(3, { severity: "low" }),
      ],
      { facets, limit: 3 },
    );
    expect(selection.findings.map((item) => item.body)).toEqual(["strong", "Finding 2", "weak"]);
    expect(selection.dropped.map((item) => [item.finding.startLine, item.reason])).toEqual([
      [3, capDropReason],
    ]);
  });

  it("uses a custom comparator instead of facets", () => {
    const selection = selectRankedFindings([finding(1), finding(2)], {
      compare: (left, right) => right.startLine - left.startLine,
    });
    expect(selection.findings.map((item) => item.startLine)).toEqual([2, 1]);
  });

  it("rejects rank keys that are not facets", () => {
    expect(() => selectRankedFindings([finding(1)], { facets, rank: ["title"] })).toThrow(
      "rank key 'title' is not an enum field",
    );
  });
});

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
