import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generateRunBundleIdentity, prepareRunBundlePackage } from "@usepipr/runtime";
import { runMain } from "../runner.js";
import {
  ledgerEvent,
  secretBody,
  secretPath,
  writeLedgerBundle,
  writeWebhookFindingEvents,
} from "./runs-ledger-fixtures.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

const reviewExecution = "0123456789abcdef0123456789abcdef";
const verifierExecution = "fedcba9876543210fedcba9876543210";

describe("pipr runs stats", () => {
  it("merges run stores and the webhook database into content-free stats", async () => {
    const { store, database, cwd, env } = await statsFixture();

    const output = await captureStdout(() =>
      runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "stats",
          "--store",
          store,
          "--webhook-db",
          database,
          "--json",
        ],
        cwd,
        env,
      }),
    );
    const stats = JSON.parse(output);

    expect(stats).toMatchObject({
      formatVersion: 1,
      sources: { runs: 2, webhookEvents: 3 },
      totals: {
        findings: 3,
        proposed: 2,
        dropped: 1,
        published: 2,
        fixed: 1,
        dismissed: 1,
        dismissalEligible: 2,
        rates: { fix: 0.5, dismissal: 0.5, acceptance: 0.5, drop: 0.5 },
      },
      dropReasons: { cap: 1 },
      errors: [],
    });
    expect(output).not.toContain(secretPath);
    expect(output).not.toContain(secretBody);
    expect(output).not.toContain("fnd_");
  });

  it("prints grouped rates and honours --since", async () => {
    const { store, database, cwd, env } = await statsFixture();

    const grouped = await captureStdout(() =>
      runMain({
        argv: ["bun", "pipr", "runs", "stats", "--store", store, "--group-by", "agent"],
        cwd,
        env: { ...env, PIPR_WEBHOOK_DB: database },
      }),
    );
    expect(grouped).toContain(
      "Rates: fix 50.0%, dismissal 50.0% of 2, acceptance 50.0%, drop 50.0%",
    );
    expect(grouped).toMatch(/^AGENT\s+FINDINGS/m);
    expect(grouped).toMatch(/^reviewer\s+3/m);

    const later = await captureStdout(() =>
      runMain({
        argv: ["bun", "pipr", "runs", "stats", "--store", store, "--since", "2026-07-21", "--json"],
        cwd,
        env,
      }),
    );
    expect(JSON.parse(later).totals.findings).toBe(0);
  });

  it("explains how to initialise a webhook database without finding events", async () => {
    const cwd = await temporaryDirectory();
    const database = path.join(cwd, "webhooks.sqlite");
    new Database(database, { create: true }).close();

    await expect(
      runMain({
        argv: ["bun", "pipr", "runs", "stats", "--store", cwd, "--webhook-db", database],
        cwd,
        env: { PIPR_UPDATE_NOTICE: "0", XDG_STATE_HOME: cwd },
      }),
    ).rejects.toThrow("run `pipr webhook serve` with this database once");
  });
});

async function statsFixture() {
  const cwd = await temporaryDirectory();
  const rawStore = await temporaryDirectory();
  const store = await temporaryDirectory();
  const published = ledgerEvent(reviewExecution, "fnd_a", "published", { sequence: 1 });
  const review = {
    formatVersion: 1 as const,
    threadResolution: "available" as const,
    events: [
      ledgerEvent(reviewExecution, "fnd_a", "proposed"),
      published,
      ledgerEvent(reviewExecution, "fnd_b", "proposed", { sequence: 2 }),
      ledgerEvent(reviewExecution, "fnd_b", "dropped", { sequence: 3 }),
    ],
    evidence: {
      fnd_a: {
        path: secretPath,
        rangeId: "range-1",
        side: "RIGHT" as const,
        startLine: 2,
        endLine: 2,
        body: secretBody,
        baseSha: "base",
        headSha: "head",
      },
    },
  };
  await writeLedgerBundle(rawStore, reviewExecution, review);
  const key = await generateRunBundleIdentity();
  await prepareRunBundlePackage({
    bundleDirectory: path.join(rawStore, reviewExecution),
    destinationRoot: store,
    recipients: [key.recipient],
  });
  await writeLedgerBundle(
    store,
    verifierExecution,
    {
      formatVersion: 1,
      threadResolution: "available",
      events: [
        ledgerEvent(verifierExecution, "fnd_a", "fixed", { at: "2026-07-20T11:00:00.000Z" }),
      ],
      evidence: {},
    },
    { startedAt: "2026-07-20T11:00:00.000Z" },
  );
  const database = path.join(cwd, "webhooks.sqlite");
  writeWebhookFindingEvents(database, [
    { host: "github", repository: "somus/pipr", event: published },
    {
      host: "github",
      repository: "somus/pipr",
      event: ledgerEvent(reviewExecution, "fnd_c", "published"),
    },
    {
      host: "github",
      repository: "somus/pipr",
      event: ledgerEvent(reviewExecution, "fnd_c", "resolved-by-human", {
        at: "2026-07-20T12:00:00.000Z",
      }),
    },
  ]);
  return { store, database, cwd, env: { PIPR_UPDATE_NOTICE: "0", XDG_STATE_HOME: cwd } };
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-stats-"));
  temporaryDirectories.push(directory);
  return directory;
}
