import { describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiprEvalCase } from "../cases.js";
import {
  aggregateEffectivenessRuns,
  runPiprEffectivenessBenchmark,
  scoreEffectivenessRun,
  writePiprEffectivenessReport,
} from "../effectiveness.js";
import {
  effectivenessBenchmarkCases,
  effectivenessBenchmarkVariants,
} from "../effectiveness-cases.js";
import type { EvalInlineFinding, PiprEvalOutput } from "../runner.js";

const expectedFinding: EvalInlineFinding = {
  body: "An older running update can overwrite the newer command attempt.",
  path: "src/review-target.ts",
  rangeId: "range-1",
  side: "RIGHT",
  startLine: 3,
  endLine: 3,
};

const positiveCase: PiprEvalCase = {
  id: "positive",
  description: "Finds a stale lifecycle overwrite.",
  baseFiles: { "src/review-target.ts": "export const state = 'old';\n" },
  headFiles: { "src/review-target.ts": "export const state = 'new';\n" },
  expected: {
    findings: [
      {
        line: 3,
        path: "src/review-target.ts",
        issueId: "stale-lifecycle-overwrite",
        keywords: ["canonical wording"],
        keywordSets: [
          ["older", "newer"],
          ["running", "stale"],
        ],
      },
    ],
    maxInlineFindings: 1,
    requirePiCall: true,
  },
};

const cleanCase: PiprEvalCase = {
  ...positiveCase,
  id: "clean",
  description: "Stays quiet on a clean lifecycle change.",
  expected: { ...positiveCase.expected, findings: [], maxInlineFindings: 0 },
};

const emptyIssueMatches = {
  structured: [],
  validated: [],
  publicationEligible: [],
  dropped: [],
  missedAtStructured: [],
};

describe("effectiveness benchmark", () => {
  it("pairs each distilled positive snapshot with a clean control", () => {
    expect(effectivenessBenchmarkCases).toHaveLength(8);
    expect(
      effectivenessBenchmarkCases.filter(({ expected }) => expected.findings.length > 0),
    ).toHaveLength(4);
    expect(
      effectivenessBenchmarkCases.filter(({ expected }) => expected.findings.length === 0),
    ).toHaveLength(4);
    expect(effectivenessBenchmarkCases.every(({ reviewer }) => reviewer === "custom")).toBe(true);
    expect(
      effectivenessBenchmarkCases.every(({ headFiles }) =>
        Object.keys(headFiles).some((filePath) => filePath.endsWith(".test.ts")),
      ),
    ).toBe(true);
    const staleCase = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-stale-lifecycle-overwrite",
    );
    expect(staleCase?.headFiles["src/review-target.ts"]).toContain(
      "only accepted may replace a record",
    );
    expect(effectivenessBenchmarkVariants.map(({ id }) => id)).toEqual([
      "generic",
      "failure-modes",
    ]);
  });

  it("separates structured recall from validation and publication eligibility", () => {
    const falsePositive = { ...expectedFinding, body: "Add another unit test.", startLine: 1 };
    const output = evalOutput({
      valid: [falsePositive],
      dropped: [
        {
          ...expectedFinding,
          reason: "finding lines fall outside the commentable range",
        },
      ],
    });

    expect(scoreEffectivenessRun(output, positiveCase.expected)).toEqual({
      succeeded: true,
      expectedIssues: 1,
      structuredFindings: 2,
      validatedFindings: 1,
      droppedFindings: 1,
      publicationEligibleFindings: 0,
      structuredRecalledIssues: 1,
      validatedRecalledIssues: 0,
      publicationEligibleRecalledIssues: 0,
      structuredUsefulFindings: 1,
      validatedUsefulFindings: 0,
      publicationEligibleUsefulFindings: 0,
      usefulDroppedFindings: 1,
    });
  });

  it("matches a stable issue id through any accepted semantic keyword set", () => {
    const output = evalOutput({
      valid: [{ ...expectedFinding, body: "A running update can leave stale command state." }],
    });

    expect(scoreEffectivenessRun(output, positiveCase.expected).structuredRecalledIssues).toBe(1);
  });

  it("recognizes the live stale-overwrite finding without requiring one canonical phrase", () => {
    const testCase = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-stale-lifecycle-overwrite",
    );
    if (!testCase) throw new Error("missing stale lifecycle benchmark case");
    const expectedLine = testCase.expected.findings[0]?.line;
    if (!expectedLine) throw new Error("missing stale lifecycle expected line");
    const output = evalOutput({
      valid: [
        {
          ...expectedFinding,
          body: "A running or completed event for a different head could overwrite an existing comment.",
          startLine: expectedLine,
          endLine: expectedLine,
        },
      ],
    });

    expect(scoreEffectivenessRun(output, testCase.expected).structuredRecalledIssues).toBe(1);
  });

  it.each([
    {
      caseId: "pr105-interrupted-result-recovery",
      body: "resultKind and resultJson remain null instead of the documented structured error.",
    },
    {
      caseId: "pr105-stale-lifecycle-overwrite",
      body: "Running and completed bypass the head check, so they can replace a record for a different reviewed head.",
    },
    {
      caseId: "pr105-stale-acceptance-supersession",
      body: 'If publishStatus("accepted") throws, reportTerminalStatus is never called.',
    },
  ])("recognizes an adjudicated live paraphrase for $caseId", ({ caseId, body }) => {
    const testCase = effectivenessBenchmarkCases.find(({ id }) => id === caseId);
    if (!testCase) throw new Error(`missing benchmark case ${caseId}`);
    const expectedLine = testCase.expected.findings[0]?.line;
    if (!expectedLine) throw new Error(`missing expected line for ${caseId}`);

    const output = evalOutput({
      valid: [
        {
          ...expectedFinding,
          body,
          startLine: expectedLine,
          endLine: expectedLine,
        },
      ],
    });

    expect(scoreEffectivenessRun(output, testCase.expected).structuredRecalledIssues).toBe(1);
  });

  it("accepts a nearby signature anchor for the same live stale-overwrite issue", () => {
    const testCase = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-stale-lifecycle-overwrite",
    );
    if (!testCase) throw new Error("missing stale lifecycle benchmark case");
    const expectedLine = testCase.expected.findings[0]?.line;
    if (!expectedLine) throw new Error("missing stale lifecycle expected line");
    const output = evalOutput({
      valid: [
        {
          ...expectedFinding,
          body: "Running and completed states from a newer attempt can overwrite the current record.",
          startLine: expectedLine - 1,
          endLine: expectedLine - 1,
        },
      ],
    });

    expect(scoreEffectivenessRun(output, testCase.expected).structuredRecalledIssues).toBe(1);
  });

  it("keeps the acceptance clean control free of secondary error masking", () => {
    const testCase = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-stale-acceptance-supersession-clean",
    );
    const source = testCase?.headFiles["src/review-target.ts"] ?? "";

    expect(source).toContain("Best-effort terminal reporting must not replace the task error");
    expect(source).toContain("throw error");
  });

  it("covers the clean lifecycle branches that the reviewer is asked to inspect", () => {
    const recovery = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-interrupted-result-recovery-clean",
    );
    const ordering = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-stale-lifecycle-overwrite-clean",
    );
    const dispatch = effectivenessBenchmarkCases.find(
      ({ id }) => id === "pr105-stale-acceptance-supersession-clean",
    );

    expect(recovery?.headFiles["src/review-target.test.ts"]).toContain(
      "preserves a retryable interrupted delivery",
    );
    expect(ordering?.headFiles["src/review-target.test.ts"]).toContain(
      "orders later states for an existing running record",
    );
    expect(dispatch?.headFiles["src/review-target.test.ts"]).toContain(
      "reports failures from every command stage",
    );
    expect(dispatch?.headFiles["src/review-target.test.ts"]).toContain(
      "reports superseded when the reviewed head changed",
    );
    expect(dispatch?.headFiles["src/review-target.test.ts"]).toContain(
      "preserves the command error when terminal reporting fails",
    );
  });

  it("aggregates issue-level recall, precision, clean accuracy, and funnel counts", () => {
    const positive = scoreEffectivenessRun(
      evalOutput({ valid: [expectedFinding], publication: [expectedFinding] }),
      positiveCase.expected,
    );
    const clean = scoreEffectivenessRun(
      evalOutput({ valid: [{ ...expectedFinding, body: "Speculative concern." }] }),
      cleanCase.expected,
    );

    expect(
      aggregateEffectivenessRuns([
        {
          caseId: "positive",
          variantId: "generic",
          repetition: 1,
          metrics: positive,
          issueMatches: emptyIssueMatches,
          artifacts: { structuredFindings: [], publicationEligibleFindings: [] },
        },
        {
          caseId: "clean",
          variantId: "generic",
          repetition: 1,
          metrics: clean,
          issueMatches: emptyIssueMatches,
          artifacts: { structuredFindings: [], publicationEligibleFindings: [] },
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        variantId: "generic",
        runs: 2,
        runSuccessRate: 1,
        structuredRecall: 1,
        validatedRecall: 1,
        publicationEligibleRecall: 1,
        structuredPrecision: 0.5,
        validatedPrecision: 0.5,
        publicationEligiblePrecision: 1,
        cleanRunAccuracy: 0,
        structuredFindings: 2,
        validatedFindings: 2,
        publicationEligibleFindings: 1,
      }),
    ]);
  });

  it("runs every case and variant repeatedly in a balanced paired order", async () => {
    const seen: string[] = [];
    const report = await runPiprEffectivenessBenchmark({
      cases: [positiveCase, cleanCase],
      variants: [
        { id: "generic", reviewInstructions: "Review generally." },
        { id: "failure-modes", reviewInstructions: "Trace failure modes." },
      ],
      repetitions: 2,
      metadata: {
        generatedAt: "2026-07-20T00:00:00.000Z",
        sourceDirty: true,
        sourceRevision: "0123456789abcdef",
      },
      runCase: async ({ testCase, variant, repetition }) => {
        seen.push(`${repetition}:${testCase.id}:${variant.id}`);
        return evalOutput();
      },
    });

    expect(seen).toEqual([
      "1:positive:generic",
      "1:positive:failure-modes",
      "1:clean:failure-modes",
      "1:clean:generic",
      "2:positive:failure-modes",
      "2:positive:generic",
      "2:clean:generic",
      "2:clean:failure-modes",
    ]);
    expect(report.runs).toHaveLength(8);
    expect(report.runs[0]?.artifacts).toEqual({
      structuredFindings: [],
      publicationEligibleFindings: [],
    });
    expect(report.metadata).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-07-20T00:00:00.000Z",
      sourceDirty: true,
      sourceRevision: "0123456789abcdef",
      model: "deepseek/deepseek-v4-pro",
      caseSnapshots: expect.arrayContaining([
        expect.objectContaining({
          caseId: "positive",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
      promptVariants: expect.arrayContaining([
        expect.objectContaining({
          variantId: "generic",
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    });
    expect(report.runs[0]?.issueMatches).toEqual({
      structured: [],
      validated: [],
      publicationEligible: [],
      dropped: [],
      missedAtStructured: ["stale-lifecycle-overwrite"],
    });
    expect(report.variants.map(({ variantId }) => variantId)).toEqual(["failure-modes", "generic"]);
  });

  it("persists the complete report as JSON", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-effectiveness-report-"));
    try {
      const outputPath = path.join(workspace, "nested", "report.json");
      const report = { metadata: { schemaVersion: 1 }, runs: [] } as never;

      await writePiprEffectivenessReport(report, outputPath);

      expect(JSON.parse(await readFile(outputPath, "utf8"))).toEqual(report);
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });
});

function evalOutput(options?: {
  valid?: EvalInlineFinding[];
  publication?: EvalInlineFinding[];
  dropped?: Array<EvalInlineFinding & { reason: string }>;
}): PiprEvalOutput {
  return {
    ok: true,
    kind: "review",
    reviewSummary: "Review completed.",
    mainComment: "Review completed.",
    inlineFindings: options?.valid ?? [],
    publicationInlineFindings: options?.publication ?? [],
    droppedFindings: options?.dropped ?? [],
    diffRanges: [],
    piCalls: [],
  };
}
