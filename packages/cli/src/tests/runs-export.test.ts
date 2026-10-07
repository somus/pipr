import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRunBundleIdentity, prepareRunBundlePackage } from "@usepipr/runtime";
import { findingDatasetCaseSchema } from "@usepipr/sdk";
import { runMain } from "../runner.js";
import { ledgerEvent, secretBody, secretPath, writeLedgerBundle } from "./runs-ledger-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const reviewExecution = "0123456789abcdef0123456789abcdef";
const verifierExecution = "fedcba9876543210fedcba9876543210";

describe("pipr runs export --dataset", () => {
  it("requires a diagnostic identity", async () => {
    const cwd = await temporaryDirectory();

    await expect(
      runMain({
        argv: ["bun", "pipr", "runs", "export", "--dataset", path.join(cwd, "out"), "--store", cwd],
        cwd,
        env: { PIPR_UPDATE_NOTICE: "0", XDG_STATE_HOME: cwd },
      }),
    ).rejects.toThrow("requires a Run Bundle identity");
  });

  it("writes labeled eval cases from decrypted ledgers and repository history", async () => {
    const cwd = await temporaryDirectory();
    const repo = await temporaryDirectory();
    const rawStore = await temporaryDirectory();
    const store = await temporaryDirectory();
    const baseSha = await commit(repo, "export const total = 1;\n");
    const headSha = await commit(repo, "export const total = 1;\nexport const refund = -1;\n");
    const evidence = (overrides: { headSha?: string } = {}) => ({
      path: secretPath,
      rangeId: "range-1",
      side: "RIGHT" as const,
      startLine: 2,
      endLine: 2,
      body: secretBody,
      baseSha,
      headSha: overrides.headSha ?? headSha,
    });
    const review = (findingId: string, sequence: number) => [
      ledgerEvent(reviewExecution, findingId, "proposed", { headSha, sequence }),
      ledgerEvent(reviewExecution, findingId, "published", { headSha, sequence: sequence + 1 }),
    ];
    await writeLedgerBundle(rawStore, reviewExecution, {
      formatVersion: 1,
      threadResolution: "available",
      events: [
        ...review("fnd_fixed", 0),
        ...review("fnd_dismissed", 2),
        ...review("fnd_gone", 4),
        ...review("fnd_open", 6),
      ],
      evidence: {
        fnd_fixed: evidence(),
        fnd_dismissed: evidence(),
        fnd_gone: evidence({ headSha: "0".repeat(40) }),
        fnd_open: evidence(),
      },
    });
    const key = await generateRunBundleIdentity();
    await prepareRunBundlePackage({
      bundleDirectory: path.join(rawStore, reviewExecution),
      destinationRoot: store,
      recipients: [key.recipient],
    });
    const later = { at: "2026-07-20T11:00:00.000Z" };
    await writeLedgerBundle(
      store,
      verifierExecution,
      {
        formatVersion: 1,
        threadResolution: "available",
        events: [
          ledgerEvent(verifierExecution, "fnd_fixed", "fixed", later),
          ledgerEvent(verifierExecution, "fnd_dismissed", "resolved-by-human", later),
          ledgerEvent(verifierExecution, "fnd_gone", "fixed", later),
        ],
        evidence: {},
      },
      { startedAt: later.at },
    );
    const identityPath = path.join(cwd, "run.agekey");
    await writeFile(identityPath, `${key.identity}\n`, { mode: 0o600 });
    const dataset = path.join(cwd, "dataset");

    const output = await captureStdout(() =>
      runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "export",
          "--dataset",
          dataset,
          "--repo",
          repo,
          "--store",
          store,
          "--identity",
          identityPath,
        ],
        cwd,
        env: { PIPR_UPDATE_NOTICE: "0", XDG_STATE_HOME: cwd },
      }),
    );

    expect(output).toContain("Exported 2 dataset cases");
    expect(output).toContain("1 commit unavailable");
    expect((await readdir(dataset)).sort()).toEqual([
      "fnd_dismissed.json",
      "fnd_fixed.json",
      "index.json",
    ]);
    const fixed = findingDatasetCaseSchema.parse(
      JSON.parse(await readFile(path.join(dataset, "fnd_fixed.json"), "utf8")),
    );
    expect(fixed).toMatchObject({
      label: "fixed",
      source: { findingId: "fnd_fixed", executionId: reviewExecution, baseSha, headSha },
      finding: { path: secretPath, body: secretBody, startLine: 2, endLine: 2 },
      baseFiles: { [secretPath]: "export const total = 1;\n" },
      headFiles: { [secretPath]: "export const total = 1;\nexport const refund = -1;\n" },
      expected: {
        findings: [
          { path: secretPath, line: 2, keywords: [], selection: { startLine: 2, endLine: 2 } },
        ],
        maxInlineFindings: 1,
      },
      modes: ["live"],
    });
    const dismissed = findingDatasetCaseSchema.parse(
      JSON.parse(await readFile(path.join(dataset, "fnd_dismissed.json"), "utf8")),
    );
    expect(dismissed).toMatchObject({
      label: "dismissed",
      expected: { findings: [], maxInlineFindings: 0 },
    });
    expect(JSON.parse(await readFile(path.join(dataset, "index.json"), "utf8"))).toEqual({
      formatVersion: 1,
      cases: [
        { id: "fnd_dismissed", label: "dismissed", file: "fnd_dismissed.json" },
        { id: "fnd_fixed", label: "fixed", file: "fnd_fixed.json" },
      ],
      skipped: { "commit-unavailable": 1 },
    });
  });
});

async function commit(repo: string, contents: string): Promise<string> {
  await git(repo, ["init", "--quiet"]).catch(() => undefined);
  const target = path.join(repo, secretPath);
  await Bun.write(target, contents);
  await git(repo, ["add", "."]);
  await git(repo, [
    "-c",
    "user.name=Pipr",
    "-c",
    "user.email=pipr@example.com",
    "commit",
    "--quiet",
    "-m",
    "change",
  ]);
  return (await git(repo, ["rev-parse", "HEAD"])).trim();
}

async function git(cwd: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return stdout;
}

async function captureStdout(run: () => Promise<void>): Promise<string> {
  const messages: string[] = [];
  const original = console.log;
  console.log = (message?: unknown) => messages.push(String(message));
  try {
    await run();
  } finally {
    console.log = original;
  }
  return messages.join("\n");
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-export-"));
  temporaryDirectories.push(directory);
  return directory;
}
