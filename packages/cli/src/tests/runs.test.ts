import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { generateRunBundleIdentity, prepareRunBundlePackage } from "@usepipr/runtime";
import { runMain } from "../runner.js";
import {
  defaultLocalTraceStore,
  printRunList,
  resolveRunSelector,
  runRunsDownload,
  runRunsList,
  runRunsShow,
} from "../runs.js";

const temporaryDirectories: string[] = [];
const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("pipr runs", () => {
  it("keeps long run states inside the STATE column", async () => {
    const startedAt = "2026-07-20T10:00:00.000Z";
    const output = await captureStdout(async () => {
      printRunList([
        {
          executionId: "0".repeat(32),
          kind: "review",
          outcome: "succeeded",
          startedAt,
          state: "indeterminate-missing",
          source: "github",
          ref: { executionId: "0".repeat(32) },
        },
      ]);
    });
    const [header, row] = output.split("\n");

    expect(row).toContain("indeterminate-missing");
    expect(row.indexOf(startedAt)).toBe(header.indexOf("STARTED"));
  });

  it("prints the reason a stored run capture failed", async () => {
    const output = await captureStdout(async () => {
      printRunList([
        {
          executionId: "0".repeat(32),
          state: "capture-failed",
          source: "filesystem",
          error: "Run artifact hash mismatch: artifacts/validation.json",
          ref: { executionId: "0".repeat(32) },
        },
      ]);
    });

    expect(output).toContain("Run artifact hash mismatch: artifacts/validation.json");
  });

  it("lists and shows local bundles without returning prompt bodies", async () => {
    const store = await temporaryDirectory();
    const executionId = "0123456789abcdef0123456789abcdef";
    await writeBundle(store, executionId);
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/actions/artifacts")) {
          return Response.json({ artifacts: [] });
        }
        if (url.pathname.endsWith("/actions/runs")) {
          return Response.json({ workflow_runs: [] });
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );

    const listOutput = await captureStdout(async () => {
      await runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "list",
          "--pr",
          "42",
          "--host",
          "github",
          "--repository",
          "somus/pipr",
          "--store",
          store,
          "--json",
        ],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });
    const listed = JSON.parse(listOutput);
    expect(listed.runs).toHaveLength(1);
    expect(listed.runs[0]).toMatchObject({ executionId, state: "available" });
    expect(listed.runs[0]).not.toHaveProperty("archiveSource");
    expect(listed.errors).toEqual([]);

    const showOutput = await captureStdout(async () => {
      await runMain({
        argv: ["bun", "pipr", "runs", "show", executionId, "--store", store, "--json"],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });
    const shown = JSON.parse(showOutput);
    expect(shown.manifest.executionId).toBe(executionId);
    expect(shown.diagnosis.executionId).toBe(executionId);
    expect(showOutput).not.toContain("private prompt body");

    const diagnosisOutput = await captureStdout(async () => {
      await runMain({
        argv: ["bun", "pipr", "runs", "show", executionId, "--store", store],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });
    expect(diagnosisOutput).toContain("Critical path:");
    expect(diagnosisOutput).toContain("pipr.task 600ms ok");
    expect(diagnosisOutput).toContain("Phase durations:");
    expect(diagnosisOutput).toContain("Tool durations:");
    expect(diagnosisOutput).toContain("read 100ms ok");
    expect(diagnosisOutput).toContain("Usage: 12 input, 5 output, $0.01");
    expect(diagnosisOutput).toContain("Resources: CPU 30ms, peak RSS 2048 bytes");
    expect(diagnosisOutput).toContain("Agent runs: 2/4");
    expect(diagnosisOutput).toContain(
      "Structural analysis: available, 25ms, 3 files, 12 declarations",
    );
    expect(diagnosisOutput).toContain(
      "reviewer (review) shard 1/2 openai/gpt-test initial#1 subscription 500ms ok",
    );
    expect(diagnosisOutput).toContain(
      "task failed (review): Task failed; download the redacted bundle for details",
    );
  });

  it("downloads a validated unpacked bundle", async () => {
    const store = await temporaryDirectory();
    const outputRoot = await temporaryDirectory();
    const destination = path.join(outputRoot, "download");
    const executionId = "fedcba9876543210fedcba9876543210";
    await writeBundle(store, executionId);

    await captureStdout(async () => {
      await runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "download",
          executionId,
          "--store",
          store,
          "--output",
          destination,
        ],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });

    expect(JSON.parse(await readFile(path.join(destination, "run.json"), "utf8"))).toMatchObject({
      executionId,
    });
  });

  it("generates a private age identity without printing its secret", async () => {
    const cwd = await temporaryDirectory();
    const sharedDirectory = path.join(cwd, "shared");
    await mkdir(sharedDirectory, { mode: 0o755 });
    await chmod(sharedDirectory, 0o755);
    const identityPath = path.join(sharedDirectory, "run.agekey");
    const output = await captureStdout(async () => {
      await runMain({
        argv: ["bun", "pipr", "runs", "keygen", "--output", identityPath],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });

    expect(output).toContain(`Identity: ${identityPath}`);
    expect(output).toMatch(/Recipient: age1[a-z0-9]+/);
    expect(output).not.toContain("AGE-SECRET-KEY");
    expect((await lstat(sharedDirectory)).mode & 0o777).toBe(0o755);
    expect((await lstat(identityPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(identityPath, "utf8")).toStartWith("AGE-SECRET-KEY-");
    await expect(
      runMain({
        argv: ["bun", "pipr", "runs", "keygen", "--output", identityPath],
        env: { PIPR_UPDATE_NOTICE: "0" },
      }),
    ).rejects.toThrow();
  });

  it("shows public metadata while locked and decrypts diagnostics with an identity", async () => {
    const rawStore = await temporaryDirectory();
    const protectedStore = await temporaryDirectory();
    const outputRoot = await temporaryDirectory();
    const executionId = "abababababababababababababababab";
    await writeBundle(rawStore, executionId);
    const key = await generateRunBundleIdentity();
    const wrongKey = await generateRunBundleIdentity();
    await prepareRunBundlePackage({
      bundleDirectory: path.join(rawStore, executionId),
      destinationRoot: protectedStore,
      recipients: [key.recipient],
    });
    const identityPath = path.join(outputRoot, "run.agekey");
    await writeFile(identityPath, `${key.identity}\n`, { mode: 0o600 });
    const wrongIdentityPath = path.join(outputRoot, "wrong.agekey");
    await writeFile(wrongIdentityPath, `${wrongKey.identity}\n`, { mode: 0o600 });

    const lockedOutput = await captureStdout(async () => {
      await runRunsShow(
        executionId,
        { store: protectedStore, json: true },
        {
          cwd: outputRoot,
          env: {},
        },
      );
    });
    expect(JSON.parse(lockedOutput)).toMatchObject({
      protection: "age",
      diagnostic: "locked",
      manifest: { capture: { mode: "metadata" } },
    });

    const unlockedOutput = await captureStdout(async () => {
      await runRunsShow(
        executionId,
        { store: protectedStore, json: true, identity: [identityPath] },
        { cwd: outputRoot, env: {} },
      );
    });
    expect(JSON.parse(unlockedOutput)).toMatchObject({
      protection: "age",
      diagnostic: "available",
      manifest: { capture: { mode: "diagnostic" } },
    });
    await expect(
      runRunsShow(
        executionId,
        { store: protectedStore, json: true, identity: [wrongIdentityPath] },
        { cwd: outputRoot, env: {} },
      ),
    ).rejects.toThrow();

    await expect(
      runRunsDownload(
        executionId,
        { store: protectedStore, output: path.join(outputRoot, "locked-download") },
        { cwd: outputRoot, env: {} },
      ),
    ).rejects.toThrow("is encrypted");

    const destination = path.join(outputRoot, "decrypted");
    await captureStdout(async () => {
      await runRunsDownload(
        executionId,
        { store: protectedStore, output: destination, identity: [identityPath] },
        { cwd: outputRoot, env: {} },
      );
    });
    expect(JSON.parse(await readFile(path.join(destination, "run.json"), "utf8"))).toMatchObject({
      executionId,
      capture: { mode: "diagnostic" },
    });
  });

  it("inspects a manually downloaded protected package directory", async () => {
    const rawStore = await temporaryDirectory();
    const protectedStore = await temporaryDirectory();
    const executionId = "bcbcbcbcbcbcbcbcbcbcbcbcbcbcbcbc";
    await writeBundle(rawStore, executionId);
    const key = await generateRunBundleIdentity();
    const prepared = await prepareRunBundlePackage({
      bundleDirectory: path.join(rawStore, executionId),
      destinationRoot: protectedStore,
      recipients: [key.recipient],
    });

    const output = await captureStdout(async () => {
      await runMain({
        argv: ["bun", "pipr", "runs", "inspect", prepared.directory, "--json"],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });

    expect(JSON.parse(output)).toMatchObject({
      protection: "age",
      diagnostic: "locked",
      manifest: {
        executionId,
        capture: { mode: "metadata" },
      },
    });
  });

  it("inspects and decrypts a manually downloaded tar.gz artifact archive", async () => {
    const rawStore = await temporaryDirectory();
    const protectedStore = await temporaryDirectory();
    const outputRoot = await temporaryDirectory();
    const executionId = "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd";
    await writeBundle(rawStore, executionId);
    const key = await generateRunBundleIdentity();
    const prepared = await prepareRunBundlePackage({
      bundleDirectory: path.join(rawStore, executionId),
      destinationRoot: protectedStore,
      recipients: [key.recipient],
    });
    const archivePath = path.join(outputRoot, "pipr-artifact.tar.gz");
    await writePackageTarGz(prepared.directory, archivePath, `.pipr-runs/${executionId}`);
    const identityPath = path.join(outputRoot, "run.agekey");
    await writeFile(identityPath, `${key.identity}\n`, { mode: 0o600 });

    const output = await captureStdout(async () => {
      await runMain({
        argv: ["bun", "pipr", "runs", "inspect", archivePath, "--identity", identityPath, "--json"],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });

    expect(JSON.parse(output)).toMatchObject({
      protection: "age",
      diagnostic: "available",
      manifest: {
        executionId,
        capture: { mode: "diagnostic" },
      },
    });
  });

  it("discovers bare --trace captures from the platform state store", async () => {
    const cwd = await temporaryDirectory();
    const stateRoot = await temporaryDirectory();
    const env = { PIPR_UPDATE_NOTICE: "0", XDG_STATE_HOME: stateRoot };
    const store = await defaultLocalTraceStore(cwd, env);
    const executionId = "c".repeat(32);
    await writeBundle(store, executionId);

    const output = await captureStdout(async () => {
      await runRunsShow(executionId, { json: true }, { cwd, env });
    });

    expect(JSON.parse(output).manifest.executionId).toBe(executionId);
  });

  it("uses a temporary state root when no home directory is configured", async () => {
    const cwd = await temporaryDirectory();
    const homedir = spyOn(os, "homedir").mockImplementation(() => {
      throw new Error("home unavailable");
    });

    try {
      const store = await defaultLocalTraceStore(cwd, {});

      expect(store.startsWith(path.join(os.tmpdir(), "pipr-state", "runs"))).toBe(true);
    } finally {
      homedir.mockRestore();
    }
  });

  it("uses an explicit GitHub selector for download outside a checkout", async () => {
    const cwd = await temporaryDirectory();
    const executionId = "d".repeat(32);
    let archiveRequested = false;
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/actions/artifacts")) {
          return Response.json({
            artifacts: [
              {
                id: 1,
                name: `pipr-run-v1-pr-42-${executionId}`,
                archive_download_url: "https://api.github.com/archive.zip",
              },
            ],
          });
        }
        if (url.pathname.endsWith("/actions/runs")) {
          return Response.json({ workflow_runs: [] });
        }
        if (url.pathname === "/archive.zip") {
          archiveRequested = true;
          return new Response("not-a-zip");
        }
        throw new Error(`Unexpected request: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );

    await expect(
      runRunsDownload(
        executionId,
        {
          host: "github",
          repository: "somus/pipr",
          output: path.join(cwd, "download"),
        },
        { cwd, env: { GITHUB_TOKEN: "test-token" } },
      ),
    ).rejects.toThrow("central directory");
    expect(archiveRequested).toBe(true);
  });

  it("deduplicates local and GitHub Actions records and prefers the local archive", async () => {
    const store = await temporaryDirectory();
    const outputRoot = await temporaryDirectory();
    const executionId = "e".repeat(32);
    await writeBundle(store, executionId);
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/actions/artifacts")) {
          return Response.json({
            artifacts: [{ id: 1, name: `pipr-run-v1-pr-42-${executionId}`, expired: false }],
          });
        }
        if (url.pathname.endsWith("/actions/runs")) {
          return Response.json({ workflow_runs: [] });
        }
        throw new Error(`GitHub Actions archive should not be selected: ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const context = { cwd: outputRoot, env: { GITHUB_TOKEN: "test-token" } };
    const common = {
      host: "github",
      repository: "somus/pipr",
      store,
    };

    const listOutput = await captureStdout(async () => {
      await runRunsList({ ...common, pr: "42", json: true }, context);
    });
    expect(JSON.parse(listOutput).runs).toEqual([
      expect.objectContaining({ executionId, source: "filesystem" }),
    ]);

    const showOutput = await captureStdout(async () => {
      await runRunsShow(executionId, { ...common, json: true }, context);
    });
    expect(JSON.parse(showOutput).manifest.executionId).toBe(executionId);

    const destination = path.join(outputRoot, "deduplicated");
    await captureStdout(async () => {
      await runRunsDownload(executionId, { ...common, output: destination }, context);
    });
    expect(JSON.parse(await readFile(path.join(destination, "run.json"), "utf8"))).toMatchObject({
      executionId,
    });
  });

  it("selects the latest completed review for show --pr unless another kind is requested", async () => {
    const store = await temporaryDirectory();
    const olderReview = "11111111111111111111111111111111";
    const newerReview = "22222222222222222222222222222222";
    const newestCommand = "33333333333333333333333333333333";
    await writeBundle(store, olderReview, { startedAt: "2026-07-20T09:00:00.000Z" });
    await writeBundle(store, newerReview, { startedAt: "2026-07-20T10:00:00.000Z" });
    await writeBundle(store, newestCommand, {
      kind: "command",
      startedAt: "2026-07-20T11:00:00.000Z",
    });
    globalThis.fetch = emptyGitHubFetch();

    const reviewOutput = await captureStdout(async () => {
      await runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "show",
          "--pr",
          "42",
          "--host",
          "github",
          "--repository",
          "somus/pipr",
          "--store",
          store,
          "--json",
        ],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });
    expect(JSON.parse(reviewOutput).manifest.executionId).toBe(newerReview);

    const commandOutput = await captureStdout(async () => {
      await runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "show",
          "--pr",
          "42",
          "--host",
          "github",
          "--repository",
          "somus/pipr",
          "--kind",
          "command",
          "--store",
          store,
          "--json",
        ],
        env: { PIPR_UPDATE_NOTICE: "0" },
      });
    });
    expect(JSON.parse(commandOutput).manifest.executionId).toBe(newestCommand);
  });

  it("uses only local stores for non-GitHub PR selectors", async () => {
    const store = await temporaryDirectory();
    const executionId = "c".repeat(32);
    await writeBundle(store, executionId, {
      host: "bitbucket",
      repository: "workspace/pipr",
    });
    let requested = false;
    globalThis.fetch = Object.assign(
      async () => {
        requested = true;
        throw new Error("Non-GitHub provider API must not be called");
      },
      { preconnect: originalFetch.preconnect },
    );

    const output = await captureStdout(async () => {
      await runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "list",
          "--pr",
          "42",
          "--host",
          "bitbucket",
          "--repository",
          "workspace/pipr",
          "--store",
          store,
          "--json",
        ],
        env: { PIPR_UPDATE_NOTICE: "0", PIPR_BITBUCKET_TOKEN: "test-token" },
      });
    });

    const listed = JSON.parse(output);
    expect(listed.runs).toEqual([expect.objectContaining({ executionId, source: "filesystem" })]);
    expect(listed.errors).toEqual([]);
    expect(requested).toBe(false);
  });
});

describe("run PR selector", () => {
  it("parses code-host PR URLs outside a checkout", async () => {
    expect(
      await resolveRunSelector({
        pr: "https://github.com/somus/pipr/pull/42",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "github", repository: "somus/pipr", changeNumber: 42 });
    expect(
      await resolveRunSelector({
        pr: "https://gitlab.com/group/pipr/-/merge_requests/7",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "gitlab", repository: "group/pipr", changeNumber: 7 });
    expect(
      await resolveRunSelector({
        pr: "https://dev.azure.com/org/project/_git/pipr/pullrequest/8",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "azure-devops", repository: "org/project/pipr", changeNumber: 8 });
    expect(
      await resolveRunSelector({
        pr: "https://azure.example.test/tfs/DefaultCollection/project/_git/pipr/pullrequest/18",
        cwd: "/does/not/exist",
      }),
    ).toEqual({
      host: "azure-devops",
      repository: "DefaultCollection/project/pipr",
      changeNumber: 18,
    });
    expect(
      await resolveRunSelector({
        pr: "https://bitbucket.org/workspace/pipr/pull-requests/9",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "bitbucket", repository: "workspace/pipr", changeNumber: 9 });
    expect(
      await resolveRunSelector({
        pr: "https://codeberg.org/somus/pipr/pulls/10",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "codeberg", repository: "somus/pipr", changeNumber: 10 });
    expect(
      await resolveRunSelector({
        pr: "https://git.example.test/somus/pipr/pulls/11",
        host: "gitea",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "gitea", repository: "somus/pipr", changeNumber: 11 });
  });

  it("requires an explicit host for ambiguous Gitea-compatible URLs", async () => {
    await expect(
      resolveRunSelector({
        pr: "https://git.example.test/somus/pipr/pulls/11",
        cwd: os.tmpdir(),
      }),
    ).rejects.toThrow(
      "Could not derive the PR host and repository; pass a PR URL or --host and --repository",
    );
  });

  it("lets explicit host and repository override remote discovery", async () => {
    expect(
      await resolveRunSelector({
        pr: "42",
        cwd: "/does/not/exist",
        host: "gitlab",
        repository: "group/pipr",
      }),
    ).toEqual({ host: "gitlab", repository: "group/pipr", changeNumber: 42 });
  });
});

async function writeBundle(
  store: string,
  executionId: string,
  options: {
    kind?: "review" | "command" | "verifier" | "startup";
    startedAt?: string;
    host?: "github" | "gitlab" | "azure-devops" | "bitbucket" | "gitea" | "forgejo" | "codeberg";
    repository?: string;
  } = {},
): Promise<void> {
  const directory = path.join(store, executionId);
  await mkdir(path.join(directory, "artifacts"), { recursive: true });
  const prompt = "private prompt body";
  await writeFile(path.join(directory, "artifacts", "prompt-001-initial.md"), prompt);
  const startedAt = options.startedAt ?? "2026-07-20T10:00:00.000Z";
  const endedAt = new Date(Date.parse(startedAt) + 1000).toISOString();
  await writeFile(
    path.join(directory, "spans.jsonl"),
    `${[
      {
        formatVersion: 1,
        traceId: executionId,
        spanId: "0123456789abcdef",
        name: "pipr.run",
        category: "run",
        startedAt,
        endedAt,
        durationMs: 1000,
        status: "ok",
        attributes: {},
      },
      {
        formatVersion: 1,
        traceId: executionId,
        spanId: "1123456789abcdef",
        parentSpanId: "0123456789abcdef",
        name: "pipr.task",
        category: "phase",
        startedAt,
        endedAt,
        durationMs: 600,
        status: "ok",
        attributes: {},
      },
      {
        formatVersion: 1,
        traceId: executionId,
        spanId: "2123456789abcdef",
        parentSpanId: "0123456789abcdef",
        name: "gen_ai.execute_tool",
        category: "tool",
        startedAt,
        endedAt,
        durationMs: 100,
        status: "ok",
        attributes: { "gen_ai.tool.name": "read" },
      },
      {
        formatVersion: 1,
        traceId: executionId,
        spanId: "3123456789abcdef",
        parentSpanId: "0123456789abcdef",
        name: "gen_ai.chat",
        category: "model",
        startedAt,
        endedAt,
        durationMs: 500,
        status: "ok",
        attributes: {
          "gen_ai.agent.name": "reviewer",
          "gen_ai.provider.name": "openai",
          "gen_ai.request.model": "gpt-test",
          "pipr.attempt.type": "initial",
          "pipr.attempt.number": 1,
          "pipr.task.name": "review",
          "pipr.auth.mode": "subscription",
          "pipr.shard.index": 1,
          "pipr.shard.count": 2,
          "gen_ai.usage.input_tokens": 12,
          "gen_ai.usage.output_tokens": 5,
          "pipr.usage.cost_usd": 0.01,
        },
      },
      {
        formatVersion: 1,
        traceId: executionId,
        spanId: "4123456789abcdef",
        parentSpanId: "0123456789abcdef",
        name: "pipr.diff.structural_analysis",
        category: "phase",
        startedAt,
        endedAt,
        durationMs: 25,
        status: "ok",
        attributes: {
          "pipr.structural.status": "available",
          "pipr.fileCount": 3,
          "pipr.declarationCount": 12,
        },
      },
      {
        formatVersion: 1,
        traceId: executionId,
        spanId: "5123456789abcdef",
        parentSpanId: "0123456789abcdef",
        name: "pipr.agent.run_budget",
        category: "internal",
        startedAt,
        endedAt,
        durationMs: 0,
        status: "ok",
        attributes: { "pipr.used": 2, "pipr.limit": 4 },
      },
    ]
      .map((span) => JSON.stringify(span))
      .join("\n")}\n`,
  );
  await writeFile(
    path.join(directory, "logs.jsonl"),
    `${JSON.stringify({
      formatVersion: 1,
      timestamp: startedAt,
      sequence: 0,
      level: "error",
      event: "task failed",
      traceId: executionId,
      spanId: "0123456789abcdef",
      fields: { task: "review", error: "provider unavailable" },
    })}\n`,
  );
  await writeFile(
    path.join(directory, "metrics.json"),
    JSON.stringify({ formatVersion: 1, counters: [], histograms: [] }),
  );
  await writeFile(
    path.join(directory, "run.json"),
    JSON.stringify({
      formatVersion: 1,
      executionId,
      kind: options.kind ?? "review",
      outcome: "succeeded",
      startedAt,
      endedAt,
      durationMs: 1000,
      repository: {
        host: options.host ?? "github",
        repository: options.repository ?? "somus/pipr",
        changeNumber: 42,
        baseSha: "base",
        headSha: "head",
      },
      pipr: { version: "0.4.3" },
      capture: {
        mode: "diagnostic",
        completeness: "complete",
        redactionApplied: true,
        truncated: false,
        limitBytes: 67_108_864,
        finalizationTimedOut: false,
        errors: [],
      },
      export: { otlp: "disabled", externalUpload: "not-configured" },
      resources: {
        cpuUserMs: 20,
        cpuSystemMs: 10,
        peakRssBytes: 2048,
        runtime: "bun 1.3.14",
      },
      signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
      artifacts: [
        {
          kind: "prompt",
          path: "artifacts/prompt-001-initial.md",
          mediaType: "text/markdown",
          sizeBytes: Buffer.byteLength(prompt),
          sha256: createHash("sha256").update(prompt).digest("hex"),
          sensitive: true,
          truncated: false,
        },
      ],
    }),
  );
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
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-runs-"));
  temporaryDirectories.push(directory);
  return directory;
}

function emptyGitHubFetch(): typeof fetch {
  return Object.assign(
    async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/actions/artifacts")) {
        return Response.json({ artifacts: [] });
      }
      if (url.pathname.endsWith("/actions/runs")) {
        return Response.json({ workflow_runs: [] });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
    { preconnect: originalFetch.preconnect },
  );
}

async function writePackageTarGz(
  packageDirectory: string,
  destination: string,
  archiveRoot: string,
): Promise<void> {
  const blocks: Uint8Array[] = [];
  for (const name of (await readdir(packageDirectory)).sort()) {
    const contents = await readFile(path.join(packageDirectory, name));
    blocks.push(testTarHeader(`${archiveRoot}/${name}`, contents.byteLength), contents);
    const padding = (512 - (contents.byteLength % 512)) % 512;
    if (padding > 0) blocks.push(new Uint8Array(padding));
  }
  blocks.push(new Uint8Array(1024));
  await writeFile(destination, gzipSync(Buffer.concat(blocks)));
}

function testTarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeTestTarField(header, 0, 100, name);
  writeTestTarField(header, 100, 8, "0000600\0");
  writeTestTarField(header, 108, 8, "0000000\0");
  writeTestTarField(header, 116, 8, "0000000\0");
  writeTestTarField(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeTestTarField(header, 136, 12, "00000000000\0");
  writeTestTarField(header, 148, 8, "        ");
  header[156] = "0".charCodeAt(0);
  writeTestTarField(header, 257, 8, "ustar\x000");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTestTarField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function writeTestTarField(
  target: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  target.set(new TextEncoder().encode(value).subarray(0, length), offset);
}
