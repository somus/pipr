import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PiprEvalCase, PiprEvalExpected } from "./cases.js";
import type { EvalInlineFinding, PiprEvalOutput } from "./runner.js";
import { piprEvalModel, runPiprEvalCase } from "./runner.js";
import { expectedFindingMatches } from "./scoring.js";

export type PiprEffectivenessVariant = {
  id: string;
  reviewInstructions: string;
};

export type PiprEffectivenessRunMetrics = {
  succeeded: boolean;
  expectedIssues: number;
  structuredFindings: number;
  validatedFindings: number;
  droppedFindings: number;
  publicationEligibleFindings: number;
  structuredRecalledIssues: number;
  validatedRecalledIssues: number;
  publicationEligibleRecalledIssues: number;
  structuredUsefulFindings: number;
  validatedUsefulFindings: number;
  publicationEligibleUsefulFindings: number;
  usefulDroppedFindings: number;
};

export type PiprEffectivenessRun = {
  caseId: string;
  variantId: string;
  repetition: number;
  error?: string;
  metrics: PiprEffectivenessRunMetrics;
  issueMatches: {
    structured: string[];
    validated: string[];
    publicationEligible: string[];
    dropped: string[];
    missedAtStructured: string[];
  };
  artifacts: {
    structuredFindings: Array<
      EvalInlineFinding & { stage: "validated" | "dropped"; reason?: string }
    >;
    publicationEligibleFindings: EvalInlineFinding[];
  };
};

export type PiprEffectivenessVariantReport = {
  variantId: string;
  runs: number;
  runSuccessRate: number;
  structuredRecall: number | null;
  validatedRecall: number | null;
  publicationEligibleRecall: number | null;
  structuredPrecision: number | null;
  validatedPrecision: number | null;
  publicationEligiblePrecision: number | null;
  cleanRunAccuracy: number | null;
  usefulDropRate: number | null;
  expectedIssues: number;
  structuredFindings: number;
  validatedFindings: number;
  droppedFindings: number;
  publicationEligibleFindings: number;
  usefulDroppedFindings: number;
};

export type PiprEffectivenessBenchmarkReport = {
  metadata: {
    schemaVersion: 1;
    generatedAt: string;
    sourceRevision: string;
    sourceDirty: boolean;
    model: string;
    caseSnapshots: Array<{ caseId: string; sha256: string }>;
    promptVariants: Array<{ variantId: string; sha256: string }>;
  };
  repetitions: number;
  caseIds: string[];
  runs: PiprEffectivenessRun[];
  variants: PiprEffectivenessVariantReport[];
};

type RunCaseInput = {
  testCase: PiprEvalCase;
  variant: PiprEffectivenessVariant;
  repetition: number;
};

export async function runPiprEffectivenessBenchmark(options: {
  cases: PiprEvalCase[];
  variants: PiprEffectivenessVariant[];
  repetitions: number;
  metadata?: {
    generatedAt?: string;
    sourceRevision?: string;
    sourceDirty?: boolean;
  };
  runCase?: (input: RunCaseInput) => Promise<PiprEvalOutput>;
}): Promise<PiprEffectivenessBenchmarkReport> {
  assertBenchmarkOptions(options);
  const runCase =
    options.runCase ??
    (async ({ testCase, variant }: RunCaseInput) =>
      await runPiprEvalCase(testCase, {
        mode: "live",
        reviewInstructions: variant.reviewInstructions,
      }));
  const runs: PiprEffectivenessRun[] = [];
  for (let repetitionIndex = 0; repetitionIndex < options.repetitions; repetitionIndex += 1) {
    for (const [caseIndex, testCase] of options.cases.entries()) {
      const variants =
        (caseIndex + repetitionIndex) % 2 === 0 ? options.variants : options.variants.toReversed();
      for (const variant of variants) {
        const repetition = repetitionIndex + 1;
        const output = await runCase({ testCase, variant, repetition });
        const issueMatches = effectivenessIssueMatches(output, testCase.expected);
        runs.push({
          caseId: testCase.id,
          variantId: variant.id,
          repetition,
          ...(output.error ? { error: output.error } : {}),
          metrics: scoreEffectivenessRun(output, testCase.expected),
          issueMatches,
          artifacts: {
            structuredFindings: [
              ...output.inlineFindings.map((finding) => ({
                ...finding,
                stage: "validated" as const,
              })),
              ...output.droppedFindings.map((finding) => ({
                ...finding,
                stage: "dropped" as const,
              })),
            ],
            publicationEligibleFindings: output.publicationInlineFindings,
          },
        });
      }
    }
  }
  return {
    metadata: effectivenessMetadata(options),
    repetitions: options.repetitions,
    caseIds: options.cases.map(({ id }) => id),
    runs,
    variants: aggregateEffectivenessRuns(runs),
  };
}

export async function writePiprEffectivenessReport(
  report: PiprEffectivenessBenchmarkReport,
  outputPath: string,
): Promise<void> {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function scoreEffectivenessRun(
  output: PiprEvalOutput,
  expected: PiprEvalExpected,
): PiprEffectivenessRunMetrics {
  const structuredFindings = [...output.inlineFindings, ...output.droppedFindings];
  const structuredMatches = matchedIssueIds(expected, structuredFindings).length;
  const validatedMatches = matchedIssueIds(expected, output.inlineFindings).length;
  const publicationMatches = matchedIssueIds(expected, output.publicationInlineFindings).length;
  return {
    succeeded: output.ok,
    expectedIssues: expected.findings.length,
    structuredFindings: structuredFindings.length,
    validatedFindings: output.inlineFindings.length,
    droppedFindings: output.droppedFindings.length,
    publicationEligibleFindings: output.publicationInlineFindings.length,
    structuredRecalledIssues: structuredMatches,
    validatedRecalledIssues: validatedMatches,
    publicationEligibleRecalledIssues: publicationMatches,
    structuredUsefulFindings: structuredMatches,
    validatedUsefulFindings: validatedMatches,
    publicationEligibleUsefulFindings: publicationMatches,
    usefulDroppedFindings: matchedIssueIds(expected, output.droppedFindings).length,
  };
}

export function aggregateEffectivenessRuns(
  runs: PiprEffectivenessRun[],
): PiprEffectivenessVariantReport[] {
  const variantIds = [...new Set(runs.map(({ variantId }) => variantId))].sort();
  return variantIds.map((variantId) => {
    const variantRuns = runs.filter((run) => run.variantId === variantId);
    const totals = sumMetrics(variantRuns.map(({ metrics }) => metrics));
    const cleanRuns = variantRuns.filter(({ metrics }) => metrics.expectedIssues === 0);
    return {
      variantId,
      runs: variantRuns.length,
      runSuccessRate: ratio(totals.succeeded, variantRuns.length) ?? 0,
      structuredRecall: ratio(totals.structuredRecalledIssues, totals.expectedIssues),
      validatedRecall: ratio(totals.validatedRecalledIssues, totals.expectedIssues),
      publicationEligibleRecall: ratio(
        totals.publicationEligibleRecalledIssues,
        totals.expectedIssues,
      ),
      structuredPrecision: ratio(totals.structuredUsefulFindings, totals.structuredFindings),
      validatedPrecision: ratio(totals.validatedUsefulFindings, totals.validatedFindings),
      publicationEligiblePrecision: ratio(
        totals.publicationEligibleUsefulFindings,
        totals.publicationEligibleFindings,
      ),
      cleanRunAccuracy: ratio(
        cleanRuns.filter(({ metrics }) => metrics.structuredFindings === 0).length,
        cleanRuns.length,
      ),
      usefulDropRate: ratio(totals.usefulDroppedFindings, totals.structuredUsefulFindings),
      expectedIssues: totals.expectedIssues,
      structuredFindings: totals.structuredFindings,
      validatedFindings: totals.validatedFindings,
      droppedFindings: totals.droppedFindings,
      publicationEligibleFindings: totals.publicationEligibleFindings,
      usefulDroppedFindings: totals.usefulDroppedFindings,
    };
  });
}

function effectivenessIssueMatches(
  output: PiprEvalOutput,
  expected: PiprEvalExpected,
): PiprEffectivenessRun["issueMatches"] {
  const structuredFindings = [...output.inlineFindings, ...output.droppedFindings];
  const structured = matchedIssueIds(expected, structuredFindings);
  const expectedIds = expected.findings.map(expectedIssueId);
  return {
    structured,
    validated: matchedIssueIds(expected, output.inlineFindings),
    publicationEligible: matchedIssueIds(expected, output.publicationInlineFindings),
    dropped: matchedIssueIds(expected, output.droppedFindings),
    missedAtStructured: expectedIds.filter((issueId) => !structured.includes(issueId)),
  };
}

function matchedIssueIds(
  expected: PiprEvalExpected,
  actual: readonly EvalInlineFinding[],
): string[] {
  const unmatchedActual = new Set(actual.keys());
  const matched: string[] = [];
  for (const [expectedIndex, finding] of expected.findings.entries()) {
    const actualIndex = [...unmatchedActual].find((index) => {
      const candidate = actual[index];
      return candidate ? expectedFindingMatches(finding, candidate) : false;
    });
    if (actualIndex === undefined) {
      continue;
    }
    unmatchedActual.delete(actualIndex);
    matched.push(expectedIssueId(finding, expectedIndex));
  }
  return matched;
}

function expectedIssueId(finding: PiprEvalExpected["findings"][number], index: number): string {
  return finding.issueId ?? `issue-${index + 1}`;
}

function effectivenessMetadata(options: {
  cases: PiprEvalCase[];
  variants: PiprEffectivenessVariant[];
  metadata?: { generatedAt?: string; sourceRevision?: string; sourceDirty?: boolean };
}): PiprEffectivenessBenchmarkReport["metadata"] {
  return {
    schemaVersion: 1,
    generatedAt: options.metadata?.generatedAt ?? new Date().toISOString(),
    sourceRevision: options.metadata?.sourceRevision ?? "unknown",
    sourceDirty: options.metadata?.sourceDirty ?? true,
    model: `${piprEvalModel.provider}/${piprEvalModel.model}`,
    caseSnapshots: options.cases.map((testCase) => ({
      caseId: testCase.id,
      sha256: sha256({
        baseFiles: testCase.baseFiles,
        deletedFiles: testCase.deletedFiles ?? [],
        expected: testCase.expected,
        headFiles: testCase.headFiles,
      }),
    })),
    promptVariants: options.variants.map((variant) => ({
      variantId: variant.id,
      sha256: sha256(variant.reviewInstructions),
    })),
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sumMetrics(metrics: PiprEffectivenessRunMetrics[]) {
  return metrics.reduce(
    (total, metric) => ({
      succeeded: total.succeeded + Number(metric.succeeded),
      expectedIssues: total.expectedIssues + metric.expectedIssues,
      structuredFindings: total.structuredFindings + metric.structuredFindings,
      validatedFindings: total.validatedFindings + metric.validatedFindings,
      droppedFindings: total.droppedFindings + metric.droppedFindings,
      publicationEligibleFindings:
        total.publicationEligibleFindings + metric.publicationEligibleFindings,
      structuredRecalledIssues: total.structuredRecalledIssues + metric.structuredRecalledIssues,
      validatedRecalledIssues: total.validatedRecalledIssues + metric.validatedRecalledIssues,
      publicationEligibleRecalledIssues:
        total.publicationEligibleRecalledIssues + metric.publicationEligibleRecalledIssues,
      structuredUsefulFindings: total.structuredUsefulFindings + metric.structuredUsefulFindings,
      validatedUsefulFindings: total.validatedUsefulFindings + metric.validatedUsefulFindings,
      publicationEligibleUsefulFindings:
        total.publicationEligibleUsefulFindings + metric.publicationEligibleUsefulFindings,
      usefulDroppedFindings: total.usefulDroppedFindings + metric.usefulDroppedFindings,
    }),
    {
      succeeded: 0,
      expectedIssues: 0,
      structuredFindings: 0,
      validatedFindings: 0,
      droppedFindings: 0,
      publicationEligibleFindings: 0,
      structuredRecalledIssues: 0,
      validatedRecalledIssues: 0,
      publicationEligibleRecalledIssues: 0,
      structuredUsefulFindings: 0,
      validatedUsefulFindings: 0,
      publicationEligibleUsefulFindings: 0,
      usefulDroppedFindings: 0,
    },
  );
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function assertBenchmarkOptions(options: {
  cases: PiprEvalCase[];
  variants: PiprEffectivenessVariant[];
  repetitions: number;
}): void {
  if (!Number.isInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("effectiveness benchmark repetitions must be a positive integer");
  }
  if (options.cases.length === 0 || options.variants.length !== 2) {
    throw new Error("effectiveness benchmark requires cases and exactly two paired variants");
  }
  if (new Set(options.variants.map(({ id }) => id)).size !== options.variants.length) {
    throw new Error("effectiveness benchmark variant ids must be unique");
  }
  if (new Set(options.cases.map(({ id }) => id)).size !== options.cases.length) {
    throw new Error("effectiveness benchmark case ids must be unique");
  }
}
