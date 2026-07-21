import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gzipSync, strToU8, zipSync } from "fflate";
import {
  AzureDevOpsRunArchiveSource,
  BitbucketRunArchiveSource,
  GitHubRunArchiveSource,
  GitLabRunArchiveSource,
} from "../provider-sources.js";

const executionId = "0123456789abcdef0123456789abcdef";
const artifactName = `pipr-run-v1-pr-42-${executionId}`;
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("provider run archive sources", () => {
  it("paginates, authenticates, retries, classifies, and downloads GitHub artifacts", async () => {
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

  it("classifies GitHub command and verifier artifacts with empty PR associations", async () => {
    const commandId = "a".repeat(32);
    const verifierId = "b".repeat(32);
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      token: "github-token",
      fetch: providerFetch(
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

  it("finds generic GitHub startup-failure artifacts by execution ID", async () => {
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: providerFetch(
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

  it("does not synthesize runs for unrelated GitHub PR workflows", async () => {
    const source = new GitHubRunArchiveSource({
      repository: "somus/pipr",
      fetch: providerFetch(
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

  it("discovers GitLab merge-request jobs and downloads their artifact", async () => {
    const requests: Request[] = [];
    const source = new GitLabRunArchiveSource({
      repository: "group/pipr",
      token: "gitlab-token",
      fetch: providerFetch(requests, [
        ["/merge_requests/42/pipelines", { body: [{ id: 77, status: "success" }] }],
        [
          "/pipelines/77/jobs",
          {
            body: [
              {
                id: 88,
                name: "pipr",
                status: "success",
                created_at: "2026-07-20T00:00:00Z",
                web_url: "https://gitlab.com/group/pipr/-/jobs/88",
                artifacts_file: { filename: `${artifactName}.zip` },
              },
            ],
          },
        ],
        ["/jobs/88/artifacts", { body: zipBundle(executionId) }],
      ]),
    });
    const records = await source.list(reviewQuery());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ state: "available", source: "gitlab" });
    expect(
      requests.every((request) => request.headers.get("authorization") === "Bearer gitlab-token"),
    ).toBe(true);
    const downloaded = await source.download(
      records[0].ref,
      path.join(await temporaryDirectory(), "gitlab"),
    );
    expect(downloaded.manifest.executionId).toBe(executionId);
  });

  it("inspects the static GitLab pipeline archive to recover the execution ID", async () => {
    const requests: Request[] = [];
    const source = new GitLabRunArchiveSource({
      repository: "group/pipr",
      fetch: providerFetch(requests, [
        ["/merge_requests/42/pipelines", { body: [{ id: 77, status: "success" }] }],
        [
          "/pipelines/77/jobs",
          {
            body: [
              {
                id: 88,
                name: "pipr",
                status: "success",
                artifacts_file: { filename: "pipr-runs-pr-42-pipeline-77.zip" },
              },
            ],
          },
        ],
        ["/jobs/88/artifacts", { body: zipBundle(executionId, `.pipr-runs/${executionId}`) }],
      ]),
    });

    const records = await source.list(reviewQuery());

    expect(records).toEqual([
      expect.objectContaining({ executionId, kind: "review", state: "available" }),
    ]);
    expect(requests.filter((request) => request.url.endsWith("/jobs/88/artifacts"))).toHaveLength(
      1,
    );
  });

  it("discovers Azure PR builds and pipeline artifacts using vso.build APIs", async () => {
    const requests: Request[] = [];
    const source = new AzureDevOpsRunArchiveSource({
      repository: "org/project/pipr",
      token: "azure-token",
      fetch: providerFetch(requests, [
        [
          "/org/project/_apis/build/builds",
          {
            body: {
              value: [
                {
                  id: 90,
                  status: "completed",
                  result: "succeeded",
                  queueTime: "2026-07-20T00:00:00Z",
                  repository: { id: "azure-repository-id", name: "pipr" },
                  _links: {
                    web: { href: "https://dev.azure.com/org/project/_build/results?buildId=90" },
                  },
                },
              ],
            },
          },
        ],
        [
          "/org/project/_apis/build/builds/90/artifacts",
          {
            body: {
              value: [
                {
                  id: 91,
                  name: artifactName,
                  resource: { downloadUrl: "https://dev.azure.com/download/91" },
                },
              ],
            },
          },
        ],
        ["/download/91", { body: zipBundle(executionId) }],
      ]),
    });
    const records = await source.list(reviewQuery());
    expect(records[0]).toMatchObject({ state: "available", source: "azure-devops" });
    const buildsRequest = requests[0];
    if (!buildsRequest) throw new Error("Azure Builds request was not made");
    expect(new URL(buildsRequest.url).searchParams.has("repositoryId")).toBe(false);
    expect(requests.some((request) => request.url.includes("/_apis/git/"))).toBe(false);
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") ===
          `Basic ${Buffer.from(":azure-token").toString("base64")}`,
      ),
    ).toBe(true);
    const downloaded = await source.download(
      records[0].ref,
      path.join(await temporaryDirectory(), "azure"),
    );
    expect(downloaded.manifest.executionId).toBe(executionId);
  });

  it("uses bearer authentication for Azure pipeline access tokens", async () => {
    const requests: Request[] = [];
    const source = new AzureDevOpsRunArchiveSource({
      repository: "org/project/pipr",
      token: "system-access-token",
      authScheme: "bearer",
      fetch: providerFetch(requests, [
        ["/org/project/_apis/build/builds", { body: { value: [] } }],
      ]),
    });

    await source.list(reviewQuery());

    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer system-access-token");
  });

  it("finds generic Azure startup-failure artifacts by execution ID", async () => {
    const source = new AzureDevOpsRunArchiveSource({
      repository: "org/project/pipr",
      fetch: providerFetch(
        [],
        [
          [
            "/org/project/_apis/build/builds",
            {
              body: {
                value: [
                  {
                    id: 90,
                    status: "completed",
                    result: "failed",
                    repository: { name: "pipr" },
                    definition: { name: "pipr" },
                  },
                ],
              },
            },
          ],
          [
            "/org/project/_apis/build/builds/90/artifacts",
            {
              body: {
                value: [
                  {
                    id: 91,
                    name: `pipr-run-v1-${executionId}`,
                    resource: { downloadUrl: "https://dev.azure.com/download/91" },
                  },
                ],
              },
            },
          ],
        ],
      ),
    });

    expect(
      await source.list({
        host: "azure-devops",
        repository: "org/project/pipr",
        executionId,
        limit: 20,
      }),
    ).toEqual([expect.objectContaining({ executionId, state: "available" })]);
    expect(await source.list(reviewQuery())).not.toContainEqual(
      expect.objectContaining({ executionId }),
    );
  });

  it("does not synthesize runs for unrelated Azure PR builds", async () => {
    const source = new AzureDevOpsRunArchiveSource({
      repository: "org/project/pipr",
      fetch: providerFetch(
        [],
        [
          [
            "/org/project/_apis/build/builds",
            {
              body: {
                value: [
                  {
                    id: 90,
                    status: "completed",
                    result: "failed",
                    repository: { name: "pipr" },
                    definition: { name: "tests", path: "\\azure-pipelines.yml" },
                  },
                ],
              },
            },
          ],
          ["/org/project/_apis/build/builds/90/artifacts", { body: { value: [] } }],
        ],
      ),
    });

    expect(await source.list(reviewQuery())).toEqual([]);
  });

  it("paginates GitLab pipelines and jobs", async () => {
    const requests: Request[] = [];
    const source = new GitLabRunArchiveSource({
      repository: "group/pipr",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/merge_requests/42/pipelines")) {
          return Response.json(
            url.searchParams.get("page") === "1" ? [] : [{ id: 77, status: "success" }],
            url.searchParams.get("page") === "1" ? { headers: { "x-next-page": "2" } } : undefined,
          );
        }
        if (url.pathname.endsWith("/pipelines/77/jobs")) {
          return Response.json(
            url.searchParams.get("page") === "1"
              ? []
              : [
                  {
                    id: 88,
                    name: "pipr",
                    status: "success",
                    artifacts_file: { filename: `${artifactName}.zip` },
                  },
                ],
            url.searchParams.get("page") === "1" ? { headers: { "x-next-page": "2" } } : undefined,
          );
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    expect(await source.list(reviewQuery())).toHaveLength(1);
    expect(requests.map((request) => new URL(request.url).searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
  });

  it("paginates Azure builds with continuation tokens", async () => {
    const requests: Request[] = [];
    const source = new AzureDevOpsRunArchiveSource({
      repository: "org/project/pipr",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/_apis/build/builds")) {
          return Response.json(
            url.searchParams.has("continuationToken")
              ? {
                  value: [
                    {
                      id: 90,
                      status: "completed",
                      result: "succeeded",
                      repository: { id: "repository-id", name: "pipr" },
                      definition: { id: 12, name: "PR validation", path: "\\" },
                    },
                  ],
                }
              : { value: [] },
            url.searchParams.has("continuationToken")
              ? undefined
              : { headers: { "x-ms-continuationtoken": "next-token" } },
          );
        }
        if (url.pathname.endsWith("/_apis/build/builds/90/artifacts")) {
          return Response.json({ value: [] });
        }
        if (url.pathname.endsWith("/_apis/build/definitions/12")) {
          return Response.json({ process: { yamlFilename: "azure-pipelines.pipr.yml" } });
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    await source.list(reviewQuery());
    expect(
      requests.some(
        (request) => new URL(request.url).searchParams.get("continuationToken") === "next-token",
      ),
    ).toBe(true);
    expect(requests.some((request) => request.url.includes("/_apis/git/"))).toBe(false);
  });

  it("correlates Bitbucket pipelines with Downloads and extracts tar.gz bundles", async () => {
    const requests: Request[] = [];
    const source = new BitbucketRunArchiveSource({
      repository: "workspace/pipr",
      email: "bot@example.com",
      token: "bitbucket-token",
      fetch: providerFetch(requests, [
        [
          "/2.0/repositories/workspace/pipr/downloads",
          {
            body: {
              values: [
                {
                  name: `${artifactName}.tar.gz`,
                  created_on: "2026-07-20T00:00:00Z",
                  links: {
                    self: { href: `https://api.bitbucket.org/files/${artifactName}.tar.gz` },
                  },
                },
              ],
            },
          },
        ],
        ["/2.0/repositories/workspace/pipr/pipelines/", { body: { values: [] } }],
        [`/files/${artifactName}.tar.gz`, { body: tarGzBundle(executionId) }],
      ]),
    });
    const records = await source.list(reviewQuery());
    expect(records[0]).toMatchObject({ state: "available", source: "bitbucket" });
    expect(
      requests.every(
        (request) =>
          request.headers.get("authorization") ===
          `Basic ${Buffer.from("bot@example.com:bitbucket-token").toString("base64")}`,
      ),
    ).toBe(true);
    const downloaded = await source.download(
      records[0].ref,
      path.join(await temporaryDirectory(), "bitbucket"),
    );
    expect(downloaded.manifest.executionId).toBe(executionId);
  });

  it("keeps pending Bitbucket pipelines in progress", async () => {
    const source = new BitbucketRunArchiveSource({
      repository: "workspace/pipr",
      fetch: providerFetch(
        [],
        [
          ["/downloads", { body: { values: [] } }],
          [
            "/pipelines/",
            {
              body: {
                values: [
                  {
                    uuid: "{pending-pipeline}",
                    state: { name: "PENDING" },
                    target: { pullrequest: { id: 42 } },
                  },
                ],
              },
            },
          ],
        ],
      ),
    });

    expect(await source.list(reviewQuery())).toEqual([
      expect.objectContaining({ state: "in-progress", outcome: "in-progress" }),
    ]);
  });

  it("follows Bitbucket Downloads and Pipelines next links", async () => {
    const requests: Request[] = [];
    const source = new BitbucketRunArchiveSource({
      repository: "workspace/pipr",
      token: "bitbucket-token",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        const url = new URL(request.url);
        if (url.pathname.endsWith("/downloads")) {
          return Response.json(
            url.searchParams.get("page") === "2"
              ? {
                  values: [
                    {
                      name: `${artifactName}.tar.gz`,
                      links: {
                        self: { href: `https://api.bitbucket.org/files/${artifactName}.tar.gz` },
                      },
                    },
                  ],
                }
              : {
                  values: [],
                  next: "https://api.bitbucket.org/2.0/repositories/workspace/pipr/downloads?page=2",
                },
          );
        }
        if (url.pathname.endsWith("/pipelines/")) {
          return Response.json(
            url.searchParams.get("page") === "2"
              ? { values: [] }
              : {
                  values: [],
                  next: "https://api.bitbucket.org/2.0/repositories/workspace/pipr/pipelines/?page=2",
                },
          );
        }
        if (url.pathname.endsWith(`/files/${artifactName}.tar.gz`)) {
          return new Response(tarGzBundle(executionId));
        }
        throw new Error(`Unexpected request: ${request.url}`);
      },
    });

    expect(await source.list(reviewQuery())).toHaveLength(1);
    expect(
      requests.filter((request) => new URL(request.url).searchParams.get("page") === "2"),
    ).toHaveLength(2);
  });

  it("rejects Bitbucket pagination outside the configured repository collection", async () => {
    const requests: Request[] = [];
    const source = new BitbucketRunArchiveSource({
      repository: "workspace/pipr",
      token: "bitbucket-token",
      fetch: async (input, init) => {
        const request =
          input instanceof Request ? new Request(input, init) : new Request(String(input), init);
        requests.push(request);
        return Response.json({
          values: [],
          next: "https://api.bitbucket.org/2.0/repositories/other/repo/downloads?page=2",
        });
      },
    });

    await expect(source.list(reviewQuery())).rejects.toThrow("outside the configured collection");
    expect(requests.some((request) => request.url.includes("/repositories/other/repo/"))).toBe(
      false,
    );
  });

  it("links completed Pipr pipelines when the native artifact is only available in CI", async () => {
    const requests: Request[] = [];
    const pipelineUrl = "https://bitbucket.org/workspace/pipr/pipelines/results/7";
    const stepsPath = "/2.0/repositories/workspace/pipr/pipelines/pipeline-7/steps";
    const stepsUrl = `https://api.bitbucket.org${stepsPath}`;
    const source = new BitbucketRunArchiveSource({
      repository: "workspace/pipr",
      token: "bitbucket-token",
      fetch: providerFetch(requests, [
        ["/2.0/repositories/workspace/pipr/downloads", { body: "payment required", status: 402 }],
        [
          "/2.0/repositories/workspace/pipr/pipelines/",
          {
            body: {
              values: [
                {
                  uuid: "{pipeline-7}",
                  build_number: 7,
                  created_on: "2026-07-21T00:00:00Z",
                  completed_on: "2026-07-21T00:01:00Z",
                  state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
                  target: { pullrequest: { id: 42 } },
                  links: {
                    steps: { href: stepsPath },
                  },
                },
              ],
            },
          },
        ],
        [stepsPath, { body: { values: [{ name: "Pipr review (run bundle v1)" }] } }],
      ]),
    });

    const records = await source.list(reviewQuery());

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      state: "available-in-ci",
      source: "bitbucket",
      outcome: "succeeded",
      nativeUrl: pipelineUrl,
    });
    expect(requests.map((request) => request.url)).toContain(stepsUrl);
  });

  it("keeps a newer completed Bitbucket pipeline when an older Download exists", async () => {
    const oldPipelineId = "{pipeline-old}";
    const pipelineUrl = "https://bitbucket.org/workspace/pipr/pipelines/results/8";
    const stepsPath = "/2.0/repositories/workspace/pipr/pipelines/pipeline-new/steps";
    const source = new BitbucketRunArchiveSource({
      repository: "workspace/pipr",
      token: "bitbucket-token",
      fetch: providerFetch(
        [],
        [
          [
            "/2.0/repositories/workspace/pipr/downloads",
            {
              body: {
                values: [
                  {
                    name: `${artifactName}.tar.gz`,
                    created_on: "2026-07-20T00:00:00Z",
                    links: {
                      self: { href: `https://api.bitbucket.org/files/${artifactName}.tar.gz` },
                    },
                  },
                ],
              },
            },
          ],
          [`/files/${artifactName}.tar.gz`, { body: tarGzBundle(executionId, oldPipelineId) }],
          [
            "/2.0/repositories/workspace/pipr/pipelines/",
            {
              body: {
                values: [
                  {
                    uuid: oldPipelineId,
                    build_number: 7,
                    created_on: "2026-07-20T00:00:00Z",
                    state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
                    target: { pullrequest: { id: 42 } },
                  },
                  {
                    uuid: "{pipeline-new}",
                    build_number: 8,
                    created_on: "2026-07-21T00:00:00Z",
                    state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
                    target: { pullrequest: { id: 42 } },
                    links: { html: { href: pipelineUrl }, steps: { href: stepsPath } },
                  },
                ],
              },
            },
          ],
          [stepsPath, { body: { values: [{ name: "Pipr review (run bundle v1)" }] } }],
        ],
      ),
    });

    const records = await source.list(reviewQuery());
    expect(records).toEqual([
      expect.objectContaining({ state: "available-in-ci", nativeUrl: pipelineUrl }),
      expect.objectContaining({ executionId, state: "available" }),
    ]);
  });

  it("rejects oversized provider archives before buffering their bodies", async () => {
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
          archiveFormat: "zip",
        },
        path.join(await temporaryDirectory(), "oversized"),
      ),
    ).rejects.toThrow("64 MiB");
  });

  it("rejects response-derived provider URLs outside the configured origin", async () => {
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
          archiveFormat: "zip",
        },
        path.join(await temporaryDirectory(), "cross-origin"),
      ),
    ).rejects.toThrow("outside the configured provider origin");
    expect(requested).toBe(false);
  });

  it("stops chunked provider archives that cross the byte limit", async () => {
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
          archiveFormat: "zip",
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

function providerFetch(
  requests: Request[],
  routes: Array<[string, { body: unknown; status?: number }]>,
): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const request =
      input instanceof Request ? new Request(input, init) : new Request(String(input), init);
    requests.push(request);
    const route = routes.find(([suffix]) => new URL(request.url).pathname.endsWith(suffix));
    if (!route) throw new Error(`Unexpected provider request: ${request.url}`);
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

function tarGzBundle(id: string, providerRunId?: string): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, contents] of Object.entries(bundleFiles(id, providerRunId))) {
    const body = strToU8(contents);
    const header = new Uint8Array(512);
    writeAscii(header, 0, 100, name);
    writeAscii(header, 100, 8, "0000600\0");
    writeAscii(header, 108, 8, "0000000\0");
    writeAscii(header, 116, 8, "0000000\0");
    writeAscii(header, 124, 12, `${body.byteLength.toString(8).padStart(11, "0")}\0`);
    writeAscii(header, 136, 12, "00000000000\0");
    writeAscii(header, 148, 8, "        ");
    header[156] = "0".charCodeAt(0);
    writeAscii(header, 257, 8, "ustar\x000");
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
    blocks.push(header, body, new Uint8Array((512 - (body.byteLength % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return gzipSync(concat(blocks), { mtime: 0 });
}

function bundleFiles(id: string, providerRunId?: string): Record<string, string> {
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
    ...(providerRunId ? { provider: { runId: providerRunId } } : {}),
    capture: {
      mode: "diagnostic",
      completeness: "complete",
      redactionApplied: true,
      truncated: false,
      limitBytes: 67_108_864,
      finalizationTimedOut: false,
      errors: [],
    },
    export: { otlp: "disabled", externalUpload: "available" },
    resources: { runtime: "bun 1.3.14" },
    signals: { spans: "spans.jsonl", logs: "logs.jsonl", metrics: "metrics.json" },
    artifacts: [],
  });
  return { "run.json": run, "spans.jsonl": spans, "logs.jsonl": logs, "metrics.json": metrics };
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(strToU8(value).subarray(0, length), offset);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipr-provider-source-"));
  temporaryDirectories.push(directory);
  return directory;
}
