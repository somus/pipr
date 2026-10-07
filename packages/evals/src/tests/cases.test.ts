import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FindingDatasetCase } from "@usepipr/sdk";
import { datasetEvalCases } from "../cases.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const exported: FindingDatasetCase = {
  formatVersion: 1,
  id: "fnd_0123456789abcdef",
  description: "fixed finding from reviewer on src/refund.ts:2-2",
  label: "fixed",
  source: {
    findingId: "fnd_0123456789abcdef",
    executionId: "0123456789abcdef0123456789abcdef",
    workId: "run_1",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    agent: "reviewer",
    facets: { severity: "high" },
  },
  finding: { path: "src/refund.ts", side: "RIGHT", startLine: 2, endLine: 2, body: "Negative" },
  baseFiles: { "src/refund.ts": "export const total = 1;\n" },
  headFiles: { "src/refund.ts": "export const total = 1;\nexport const refund = -1;\n" },
  expected: {
    findings: [
      {
        path: "src/refund.ts",
        line: 2,
        keywords: [],
        selection: { startLine: 2, endLine: 2 },
      },
    ],
    maxInlineFindings: 1,
  },
  modes: ["live"],
};

async function writeDataset(cases: unknown[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-eval-dataset-"));
  directories.push(directory);
  const entries = [];
  for (const [index, testCase] of cases.entries()) {
    const file = `case-${index}.json`;
    await writeFile(path.join(directory, file), JSON.stringify(testCase));
    entries.push({ id: `case-${index}`, label: "fixed", file });
  }
  await writeFile(
    path.join(directory, "index.json"),
    JSON.stringify({ formatVersion: 1, cases: entries, skipped: {} }),
  );
  return directory;
}

describe("exported dataset eval cases", () => {
  it("loads exported finding cases as live eval cases", async () => {
    const directory = await writeDataset([exported]);

    expect(await datasetEvalCases(directory)).toEqual([
      {
        id: "dataset-fnd_0123456789abcdef",
        description: exported.description,
        baseFiles: exported.baseFiles,
        headFiles: exported.headFiles,
        expected: exported.expected,
        modes: ["live"],
      },
    ]);
  });

  it("rejects cases that do not match the dataset schema", async () => {
    const directory = await writeDataset([{ ...exported, label: "dismissed" }]);

    await expect(datasetEvalCases(directory)).rejects.toThrow();
  });
});
