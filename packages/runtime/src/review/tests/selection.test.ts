import { describe, expect, it } from "bun:test";
import type { ReviewFinding } from "@usepipr/sdk";
import { rankFindings } from "../selection.js";

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

describe("rankFindings", () => {
  it("ranks by facet declaration order, then by input order", () => {
    const selection = rankFindings(
      [
        finding(1, { severity: "low" }),
        finding(2, { severity: "critical", category: "bug" }),
        finding(3, { severity: "critical", category: "security" }),
        finding(4),
      ],
      { facets },
    );
    expect(selection.map((item) => item.startLine)).toEqual([3, 2, 1, 4]);
  });

  it("honors an explicit rank order", () => {
    const selection = rankFindings(
      [
        finding(1, { severity: "critical", category: "bug" }),
        finding(2, { severity: "low", category: "security" }),
      ],
      { facets, rank: ["category"] },
    );
    expect(selection.map((item) => item.startLine)).toEqual([2, 1]);
  });

  it("keeps distinct findings at one location", () => {
    const selection = rankFindings(
      [
        finding(1, { severity: "low", body: "weak" }),
        finding(1, { severity: "high", body: "strong" }),
        finding(2, { severity: "high" }),
        finding(3, { severity: "low" }),
      ],
      { facets },
    );
    expect(selection.map((item) => item.body)).toEqual([
      "strong",
      "Finding 2",
      "weak",
      "Finding 3",
    ]);
  });

  it("uses a custom comparator instead of facets", () => {
    const selection = rankFindings([finding(1), finding(2)], {
      compare: (left, right) => right.startLine - left.startLine,
    });
    expect(selection.map((item) => item.startLine)).toEqual([2, 1]);
  });

  it("rejects rank keys that are not facets", () => {
    expect(() => rankFindings([finding(1)], { facets, rank: ["title"] })).toThrow(
      "rank key 'title' is not an enum field",
    );
  });
});
