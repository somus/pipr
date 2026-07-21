import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMain } from "../runner.js";
import {
  defaultLocalTraceStore,
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
  it("lists and shows local bundles without returning prompt bodies", async () => {
    const store = await temporaryDirectory();
    const executionId = "0123456789abcdef0123456789abcdef";
    await writeBundle(store, executionId);

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
    expect(listed.errors).toEqual([
      expect.objectContaining({
        source: "github",
        message: expect.stringContaining("GITHUB_TOKEN"),
      }),
    ]);

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

  it("uses explicit provider selectors for download outside a checkout", async () => {
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

  it("deduplicates local and provider records and prefers the local archive", async () => {
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
        throw new Error(`Provider archive should not be selected: ${url}`);
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

  it("links Bitbucket native CI artifacts that cannot be downloaded through the API", async () => {
    const store = await temporaryDirectory();
    const pipelineUrl = "https://bitbucket.org/workspace/pipr/pipelines/results/7";
    globalThis.fetch = Object.assign(
      async (input: string | URL | Request) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.pathname.endsWith("/downloads")) return Response.json({ values: [] });
        if (url.pathname.endsWith("/pipelines/")) {
          return Response.json({
            values: [
              {
                uuid: "{pipeline-7}",
                created_on: "2026-07-21T00:00:00Z",
                completed_on: "2026-07-21T00:01:00Z",
                state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
                target: { pullrequest: { id: 42 } },
                links: {
                  html: { href: pipelineUrl },
                  steps: {
                    href: "https://api.bitbucket.org/2.0/repositories/workspace/pipr/pipelines/pipeline-7/steps",
                  },
                },
              },
            ],
          });
        }
        if (url.pathname.endsWith("/pipelines/pipeline-7/steps")) {
          return Response.json({ values: [{ name: "Pipr review (run bundle v1)" }] });
        }
        throw new Error(`Unexpected request: ${url}`);
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
        ],
        env: { PIPR_UPDATE_NOTICE: "0", PIPR_BITBUCKET_TOKEN: "test-token" },
      });
    });

    expect(output).toContain("available-in-ci");
    expect(output).toContain(pipelineUrl);

    await expect(
      runMain({
        argv: [
          "bun",
          "pipr",
          "runs",
          "show",
          "--pr",
          "42",
          "--host",
          "bitbucket",
          "--repository",
          "workspace/pipr",
          "--store",
          store,
        ],
        env: { PIPR_UPDATE_NOTICE: "0", PIPR_BITBUCKET_TOKEN: "test-token" },
      }),
    ).rejects.toThrow(pipelineUrl);
  });
});

describe("run PR selector", () => {
  it("parses provider PR URLs outside a checkout", async () => {
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
        pr: "https://bitbucket.org/workspace/pipr/pull-requests/9",
        cwd: "/does/not/exist",
      }),
    ).toEqual({ host: "bitbucket", repository: "workspace/pipr", changeNumber: 9 });
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
          "gen_ai.usage.input_tokens": 12,
          "gen_ai.usage.output_tokens": 5,
          "pipr.usage.cost_usd": 0.01,
        },
      },
    ]
      .map((span) => JSON.stringify(span))
      .join("\n")}\n`,
  );
  await writeFile(path.join(directory, "logs.jsonl"), "");
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
        host: "github",
        repository: "somus/pipr",
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
