import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import { GitHubRunArchiveSource } from "../github-run-archive-source.js";
import { generateRunBundleIdentity, prepareRunBundlePackage } from "../protected-package.js";
import { startFileRunRecorder } from "../recorder.js";

const executionId = "0123456789abcdef0123456789abcdef";
const artifactName = `pipr-run-v1-pr-42-${executionId}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("GitHub run archive source", () => {
  it("paginates, authenticates, retries, classifies, and downloads artifacts", async () => {
    const requests: Request[] = [];
    let firstPageAttempts = 0;
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      token: "github-token",
      sleep: async () => {},
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/actions/artifacts") && url.searchParams.get("page") === "1") {
          firstPageAttempts += 1;
          if (firstPageAttempts === 1) return new Response("temporary", { status: 503 });
          return Response.json(
            {
              artifacts: [
                {
                  id: 10,
                  name: `pipr-run-v1-pr-42-${"f".repeat(32)}`,
                  expired: true,
                  created_at: "2026-07-19T00:00:00Z",
                  workflow_run: { id: 100 },
                },
              ],
            },
            { headers: { Link: '<https://api.github.com/next>; rel="next"' } },
          );
        }
        if (url.pathname === "/next") {
          return Response.json({
            artifacts: [
              {
                id: 11,
                name: artifactName,
                expired: false,
                created_at: "2026-07-20T00:00:00Z",
                workflow_run: { id: 101 },
              },
            ],
          });
        }
        if (url.pathname.endsWith("/actions/runs")) return Response.json({ workflow_runs: [] });
        if (url.pathname.endsWith("/actions/artifacts/11/zip")) {
          return new Response(zipBundle(executionId));
        }
        throw new Error(`Unexpected GitHub request: ${request.url}`);
      },
    });

    const records = await source.list(reviewQuery());
    expect(records.map((record) => record.state)).toEqual(["available", "expired"]);
    expect(
      requests.every((request) => request.headers.get("authorization") === "Bearer github-token"),
    ).toBe(true);
    expect(firstPageAttempts).toBe(2);
    const destination = path.join(await temporaryDirectory(), "github");
    const downloaded = await source.download(
      { ...records[0].ref, preserveArchive: true },
      destination,
    );
    expect(downloaded.manifest.executionId).toBe(executionId);
    expect(downloaded.archivePath).toBe(`${destination}.zip`);

    const protectedDestination = path.join(await temporaryDirectory(), "protected");
    await writeFile(`${protectedDestination}.zip`, "keep");
    await expect(
      source.download({ ...records[0].ref, preserveArchive: true }, protectedDestination),
    ).rejects.toThrow();
    expect(await readFile(`${protectedDestination}.zip`, "utf8")).toBe("keep");
  });

  it("discovers and anonymously downloads protected artifacts", async () => {
    const requests: Request[] = [];
    const protectedBundle = await protectedZipBundle();
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: githubFetch(requests, [
        [
          "/actions/artifacts",
          {
            body: {
              artifacts: [
                {
                  id: 11,
                  name: `pipr-run-v1-age-pr-42-${protectedBundle.executionId}`,
                  expired: false,
                  created_at: "2026-07-20T00:00:00Z",
                },
              ],
            },
          },
        ],
        ["/actions/runs", { body: { workflow_runs: [] } }],
        ["/actions/artifacts/11/zip", { body: protectedBundle.archive }],
      ]),
    });

    const records = await source.list(reviewQuery());
    expect(records).toEqual([
      expect.objectContaining({
        executionId: protectedBundle.executionId,
        protection: "age",
        state: "available",
      }),
    ]);
    const record = records[0];
    if (!record) throw new Error("Expected the protected GitHub artifact");
    const downloaded = await source.download(
      record.ref,
      path.join(await temporaryDirectory(), "github-protected"),
    );

    expect(requests.every((request) => request.headers.get("authorization") === null)).toBe(true);
    expect(downloaded.envelope).toMatchObject({
      executionId: protectedBundle.executionId,
      protection: "age",
      diagnosticState: "available",
    });
    expect(downloaded.manifest.capture.mode).toBe("metadata");
    expect(downloaded.packageDirectory).toBeDefined();
  });

  it("classifies command and verifier artifacts with empty PR associations", async () => {
    const commandId = "a".repeat(32);
    const verifierId = "b".repeat(32);
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      token: "github-token",
      fetch: githubFetch(
        [],
        [
          [
            "/actions/artifacts",
            {
              body: {
                artifacts: [
                  {
                    id: 1,
                    name: `pipr-run-v1-pr-42-${commandId}`,
                    workflow_run: { id: 101 },
                  },
                  {
                    id: 2,
                    name: `pipr-run-v1-pr-42-${verifierId}`,
                    workflow_run: { id: 102 },
                  },
                ],
              },
            },
          ],
          [
            "/actions/runs",
            {
              body: {
                workflow_runs: [
                  {
                    id: 101,
                    event: "issue_comment",
                    status: "completed",
                    conclusion: "success",
                    name: "pipr",
                    pull_requests: [],
                  },
                  {
                    id: 102,
                    event: "pull_request_review_comment",
                    status: "completed",
                    conclusion: "success",
                    name: "pipr",
                    pull_requests: [],
                  },
                ],
              },
            },
          ],
        ],
      ),
    });

    expect(await source.list({ ...reviewQuery(), kind: "command" })).toEqual([
      expect.objectContaining({ executionId: commandId, kind: "command" }),
    ]);
  });

  it("finds generic startup-failure artifacts only by execution ID", async () => {
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: githubFetch(
        [],
        [
          [
            "/actions/artifacts",
            {
              body: {
                artifacts: [{ id: 1, name: `pipr-run-v1-${executionId}`, expired: false }],
              },
            },
          ],
          ["/actions/runs", { body: { workflow_runs: [] } }],
        ],
      ),
    });

    expect(
      await source.list({
        host: "github",
        repository: "somus/pipr",
        executionId,
        limit: 20,
      }),
    ).toEqual([expect.objectContaining({ executionId, state: "available" })]);
    expect(await source.list(reviewQuery())).not.toContainEqual(
      expect.objectContaining({ executionId }),
    );
  });

  it("does not synthesize runs for unrelated PR workflows", async () => {
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: githubFetch(
        [],
        [
          ["/actions/artifacts", { body: { artifacts: [] } }],
          [
            "/actions/runs",
            {
              body: {
                workflow_runs: [
                  {
                    id: 101,
                    name: "tests",
                    path: ".github/workflows/test.yml",
                    status: "completed",
                    conclusion: "failure",
                    pull_requests: [{ number: 42 }],
                  },
                ],
              },
            },
          ],
        ],
      ),
    });

    expect(await source.list(reviewQuery())).toEqual([]);
  });

  it("rejects oversized GitHub Actions archives before buffering their bodies", async () => {
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: async () =>
        new Response(new Uint8Array([1]), {
          headers: { "content-length": String(64 * 1024 * 1024 + 1) },
        }),
    });

    await expect(
      source.download(
        {
          executionId,
          archiveUrl: "https://api.github.com/archive.zip",
        },
        path.join(await temporaryDirectory(), "oversized"),
      ),
    ).rejects.toThrow("64 MiB");
  });

  it("rejects response-derived URLs outside the configured origin", async () => {
    let requested = false;
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      token: "github-token",
      fetch: async () => {
        requested = true;
        return new Response(zipBundle(executionId));
      },
    });

    await expect(
      source.download(
        {
          executionId,
          archiveUrl: "https://attacker.example/archive.zip",
        },
        path.join(await temporaryDirectory(), "cross-origin"),
      ),
    ).rejects.toThrow("outside the configured API origin");
    expect(requested).toBe(false);
  });

  it("stops chunked GitHub Actions archives that cross the byte limit", async () => {
    const chunk = new Uint8Array(1024 * 1024);
    let emitted = 0;
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              if (emitted >= 65) return controller.close();
              emitted += 1;
              controller.enqueue(chunk);
            },
          }),
        ),
    });

    await expect(
      source.download(
        {
          executionId,
          archiveUrl: "https://api.github.com/chunked.zip",
        },
        path.join(await temporaryDirectory(), "chunked"),
      ),
    ).rejects.toThrow("64 MiB");
    expect(emitted).toBe(65);
  });
});

function reviewQuery() {
  return {
    host: "github" as const,
    repository: "somus/pipr",
    changeNumber: 42,
    kind: "review" as const,
    limit: 20,
  };
}

function githubFetch(
  requests: Request[],
  routes: Array<[string, { body: unknown; status?: number }]>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    const route = routes.find(([suffix]) => new URL(request.url).pathname.endsWith(suffix));
    if (!route) throw new Error(`Unexpected GitHub request: ${request.url}`);
    return route[1].body instanceof Uint8Array || typeof route[1].body === "string"
      ? new Response(route[1].body, { status: route[1].status })
      : Response.json(route[1].body, { status: route[1].status });
  };
}

function zipBundle(id: string, prefix?: string): Uint8Array {
  const directories = prefix
    ? Object.fromEntries(
        prefix
          .split("/")
          .map((_, index, segments) => [
            `${segments.slice(0, index + 1).join("/")}/`,
            new Uint8Array(),
          ]),
      )
    : {};
  return zipSync({
    ...directories,
    ...Object.fromEntries(
      Object.entries(bundleFiles(id)).map(([name, contents]) => [
        prefix ? `${prefix}/${name}` : name,
        strToU8(contents),
      ]),
    ),
  });
}

function bundleFiles(id: string): Record<string, string> {
  const startedAt = "2026-07-20T00:00:00.000Z";
  const spans = `${JSON.stringify({
    formatVersion: 1,
    traceId: id,
    spanId: "0123456789abcdef",
    name: "pipr.run",
    category: "run",
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    status: "ok",
    attributes: {},
  })}\n`;
  const logs = "";
  const metrics = JSON.stringify({ formatVersion: 1, counters: [], histograms: [] });
  const run = JSON.stringify({
    formatVersion: 1,
    executionId: id,
    kind: "review",
    outcome: "succeeded",
    startedAt,
    endedAt: startedAt,
    durationMs: 0,
    repository: { host: "github", repository: "somus/pipr", changeNumber: 42 },
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
    export: { otlp: "disabled", externalUpload: "pending" },
    resources: { runtime: "bun 1.3.14" },
    signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
    artifacts: [],
  });
  return { "run.json": run, "spans.jsonl": spans, "logs.jsonl": logs, "metrics.json": metrics };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-github-source-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function protectedZipBundle(): Promise<{
  executionId: string;
  archive: Uint8Array;
}> {
  const root = await temporaryDirectory();
  const recorder = await startFileRunRecorder({
    rootDirectory: path.join(root, "capture"),
    mode: "diagnostic",
    env: {},
  });
  await recorder.addArtifact({
    kind: "prompt",
    name: "prompt.md",
    mediaType: "text/markdown",
    content: "diagnostic-private-body",
    sensitive: true,
  });
  await recorder.finish({
    kind: "review",
    outcome: "succeeded",
    repository: {
      host: "github",
      repository: "somus/pipr",
      changeNumber: 42,
    },
  });
  const key = await generateRunBundleIdentity();
  const prepared = await prepareRunBundlePackage({
    bundleDirectory: recorder.directory,
    destinationRoot: path.join(root, "published"),
    recipients: [key.recipient],
  });
  const files = await readdir(prepared.directory);
  return {
    executionId: recorder.executionId,
    archive: zipSync(
      Object.fromEntries(
        await Promise.all(
          files.map(async (name) => [
            `.pipr-runs/${recorder.executionId}/${name}`,
            new Uint8Array(await readFile(path.join(prepared.directory, name))),
          ]),
        ),
      ),
    ),
  };
}
