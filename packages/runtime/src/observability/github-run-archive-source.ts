import { createHash } from "node:crypto";
import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DownloadedBundle, RunArchiveSource, RunQuery, RunRecord, RunRef } from "./archive.js";
import { extractRunArchive, extractRunArchiveFiles } from "./archive-extraction.js";
import { copyRunBundlePackage } from "./protected-package.js";
import { maximumRunBundleBytes } from "./types.js";

type GitHubSourceOptions = {
  repository: string;
  token?: string;
  fetch?: GitHubFetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type GitHubClient = {
  fetch: GitHubFetch;
  headers: Record<string, string>;
  origin: string;
  sleep: (milliseconds: number) => Promise<void>;
};

type GitHubFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const pullRequestArtifactPattern = /^pipr-run-v1-(?:(metadata|age)-)?pr-(\d+)-([a-f0-9]{32})$/;
const genericArtifactPattern = /^pipr-run-v1-(?:(metadata|age)-)?([a-f0-9]{32})$/;

const githubArtifactSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  expired: z.boolean().default(false),
  created_at: z.string().optional(),
  expires_at: z.string().nullable().optional(),
  archive_download_url: z.string().url().optional(),
  workflow_run: z.object({ id: z.union([z.number(), z.string()]) }).optional(),
});
const githubArtifactsSchema = z.object({ artifacts: z.array(githubArtifactSchema) });
const githubRunsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.union([z.number(), z.string()]),
      event: z.string().optional(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
      name: z.string().optional(),
      path: z.string().optional(),
      created_at: z.string().optional(),
      updated_at: z.string().optional(),
      html_url: z.string().url().optional(),
      pull_requests: z.array(z.object({ number: z.number().int().positive() })).default([]),
    }),
  ),
});

export class GitHubRunArchiveSource implements RunArchiveSource {
  private readonly apiBaseUrl: string;
  private readonly client: GitHubClient;
  private readonly options: GitHubSourceOptions & { apiBaseUrl?: string };

  constructor(options: GitHubSourceOptions & { apiBaseUrl?: string }) {
    this.client = githubClient(
      options,
      {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2026-03-10",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      options.apiBaseUrl ?? "https://api.github.com",
    );
    this.options = options;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  async list(query: RunQuery): Promise<RunRecord[]> {
    const artifacts = await this.listArtifacts();
    const workflowRuns = await this.listWorkflowRuns();
    const matchingWorkflowRuns =
      query.changeNumber === undefined
        ? workflowRuns
        : workflowRuns.filter((run) =>
            run.pull_requests.some((pullRequest) => pullRequest.number === query.changeNumber),
          );
    const runsById = new Map(workflowRuns.map((run) => [String(run.id), run]));
    const linkedArtifacts = artifacts
      .map((artifact) => this.artifactRecord(artifact, runsById, query.changeNumber))
      .filter((record): record is { record: RunRecord; workflowRunId?: string } => Boolean(record));
    const artifactRunIds = new Set(
      linkedArtifacts.flatMap((item) => (item.workflowRunId ? [item.workflowRunId] : [])),
    );
    const records = linkedArtifacts.map((item) => item.record);
    records.push(
      ...matchingWorkflowRuns
        .filter((run) => !artifactRunIds.has(String(run.id)))
        .map((run) => missingGitHubArtifactRecord(run)),
    );
    return finalizeRecords(records, query);
  }

  async download(ref: RunRef, destination: string): Promise<DownloadedBundle> {
    return await downloadGitHubArchive(this.client, ref, destination);
  }

  private artifactRecord(
    artifact: z.infer<typeof githubArtifactSchema>,
    runsById: Map<string, z.infer<typeof githubRunsSchema>["workflow_runs"][number]>,
    changeNumber: number | undefined,
  ): { record: RunRecord; workflowRunId?: string } | undefined {
    const identity = parseArtifactName(artifact.name, changeNumber);
    if (!identity) return undefined;
    const linked = linkedGitHubWorkflow(artifact, runsById);
    const record: RunRecord = {
      executionId: identity.executionId,
      kind: githubRunKind(linked.run?.event),
      state: artifact.expired ? "expired" : "available",
      protection: identity.protection,
      source: "github",
      ref: {
        executionId: identity.executionId,
        providerId: String(artifact.id),
        archiveUrl:
          artifact.archive_download_url ??
          `${this.apiBaseUrl}/repos/${this.options.repository}/actions/artifacts/${artifact.id}/zip`,
      },
    };
    setDefined(
      record,
      "outcome",
      linked.run ? githubOutcome(linked.run.status, linked.run.conclusion) : undefined,
    );
    setDefined(record, "startedAt", artifact.created_at);
    setDefined(record, "nativeUrl", linked.run?.html_url);
    const result: { record: RunRecord; workflowRunId?: string } = { record };
    setDefined(result, "workflowRunId", linked.id);
    return result;
  }

  private async listArtifacts() {
    const artifacts: z.infer<typeof githubArtifactSchema>[] = [];
    let url: string | undefined =
      `${this.apiBaseUrl}/repos/${this.options.repository}/actions/artifacts?per_page=100&page=1`;
    while (url) {
      const response: Response = await githubRequest(this.client, url);
      artifacts.push(...githubArtifactsSchema.parse(await response.json()).artifacts);
      url = nextLink(response.headers.get("link"));
    }
    return artifacts;
  }

  private async listWorkflowRuns() {
    const runs: z.infer<typeof githubRunsSchema>["workflow_runs"] = [];
    let url: string | undefined =
      `${this.apiBaseUrl}/repos/${this.options.repository}/actions/runs?per_page=100&page=1`;
    while (url) {
      const response: Response = await githubRequest(this.client, url);
      runs.push(...githubRunsSchema.parse(await response.json()).workflow_runs);
      url = nextLink(response.headers.get("link"));
    }
    return runs.filter(
      (run) => run.name?.toLowerCase() === "pipr" || /(?:^|\/)pipr\.ya?ml$/i.test(run.path ?? ""),
    );
  }
}

async function downloadGitHubArchive(
  client: GitHubClient,
  ref: RunRef,
  destination: string,
): Promise<DownloadedBundle> {
  if (!ref.archiveUrl) {
    throw new Error(`Run ${ref.executionId} does not have an available GitHub Actions archive`);
  }
  const response = await githubRequest(client, ref.archiveUrl);
  const archive = await readGitHubArchive(response);
  let createdArchivePath: string | undefined;
  try {
    const downloaded = await materializeGitHubArchive(archive, destination);
    if (downloaded.manifest.executionId !== ref.executionId) {
      await rm(destination, { recursive: true, force: true });
      throw new Error("Downloaded run execution ID does not match the GitHub Actions record");
    }
    if (!ref.preserveArchive) return downloaded;
    const archivePath = `${destination}.zip`;
    await writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
    createdArchivePath = archivePath;
    await chmod(archivePath, 0o600);
    return { ...downloaded, archivePath };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    if (createdArchivePath) await rm(createdArchivePath, { force: true });
    throw error;
  }
}

async function materializeGitHubArchive(
  archive: Uint8Array,
  destination: string,
): Promise<DownloadedBundle> {
  const inspectionRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-github-package-"));
  try {
    const extracted = path.join(inspectionRoot, "contents");
    await extractRunArchiveFiles({ archive, format: "zip", destination: extracted });
    const envelopes = await findNamedFiles(extracted, "envelope.json");
    if (envelopes.length === 0) {
      return await extractRunArchive({ archive, format: "zip", destination });
    }
    if (envelopes.length !== 1) {
      throw new Error(
        `GitHub Actions archive must contain exactly one envelope.json; found ${envelopes.length}`,
      );
    }
    const sourcePackage = path.dirname(envelopes[0]);
    return await copyRunBundlePackage(sourcePackage, destination);
  } finally {
    await rm(inspectionRoot, { recursive: true, force: true });
  }
}

async function findNamedFiles(root: string, name: string): Promise<string[]> {
  const matches: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("GitHub Actions archive contains a symlink");
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name === name) matches.push(target);
    }
  };
  await visit(root);
  return matches;
}

async function readGitHubArchive(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumRunBundleBytes) {
      await response.body?.cancel();
      throw new Error("Run archive exceeds the 64 MiB bundle limit");
    }
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumRunBundleBytes) {
        await reader.cancel();
        throw new Error("Run archive exceeds the 64 MiB bundle limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const archive = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return archive;
}

function githubClient(
  options: Pick<GitHubSourceOptions, "fetch" | "sleep">,
  headers: Record<string, string>,
  apiBaseUrl: string,
): GitHubClient {
  return {
    fetch: options.fetch ?? fetch,
    headers,
    origin: new URL(apiBaseUrl).origin,
    sleep:
      options.sleep ??
      (async (milliseconds) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
      }),
  };
}

async function githubRequest(client: GitHubClient, url: string): Promise<Response> {
  if (new URL(url).origin !== client.origin) {
    throw new Error("GitHub Actions URL points outside the configured API origin");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await client.fetch(url, { headers: client.headers, redirect: "follow" });
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await client.sleep(retryDelay(response, attempt));
      continue;
    }
    throw new Error(`GitHub Actions request failed with HTTP ${response.status}`);
  }
  throw new Error("GitHub Actions request exhausted retries");
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1000, 5_000)
    : Math.min(250 * 2 ** attempt, 2_000);
}

type ArtifactIdentity = {
  executionId: string;
  protection: "plaintext" | "metadata" | "age" | "unknown";
};

function parseArtifactName(
  name: string | undefined,
  expectedChangeNumber?: number,
): ArtifactIdentity | undefined {
  if (!name) return undefined;
  const pullRequestMatch = pullRequestArtifactPattern.exec(name);
  if (pullRequestMatch) return pullRequestArtifactIdentity(pullRequestMatch, expectedChangeNumber);
  if (expectedChangeNumber !== undefined) return undefined;
  const genericMatch = genericArtifactPattern.exec(name);
  return genericMatch ? artifactIdentity(genericMatch[2], genericMatch[1]) : undefined;
}

function pullRequestArtifactIdentity(
  match: RegExpExecArray,
  expectedChangeNumber: number | undefined,
): ArtifactIdentity | undefined {
  if (expectedChangeNumber !== undefined && Number(match[2]) !== expectedChangeNumber) {
    return undefined;
  }
  return artifactIdentity(match[3], match[1]);
}

function artifactIdentity(executionId: string, protection: string | undefined): ArtifactIdentity {
  return {
    executionId,
    protection: protection === "metadata" || protection === "age" ? protection : "unknown",
  };
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

function finalizeRecords(records: RunRecord[], query: RunQuery): RunRecord[] {
  return records
    .filter((record) => !query.executionId || record.executionId === query.executionId)
    .filter((record) => !query.kind || query.kind === "all" || record.kind === query.kind)
    .filter(
      (record) => !query.status || record.state === query.status || record.outcome === query.status,
    )
    .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
    .slice(0, query.limit ?? 20);
}

function githubRunKind(event: string | undefined): "review" | "command" | "verifier" {
  if (event === "issue_comment") return "command";
  if (event === "pull_request_review_comment") return "verifier";
  return "review";
}

function githubOutcome(
  status: string,
  conclusion: string | null | undefined,
): RunRecord["outcome"] {
  if (status !== "completed") return "in-progress";
  return conclusion === "success" ? "succeeded" : conclusion ? "failed" : "partial";
}

function missingGitHubArtifactRecord(
  run: z.infer<typeof githubRunsSchema>["workflow_runs"][number],
): RunRecord {
  const executionId = syntheticExecutionId("github", run.id);
  const outcome = githubOutcome(run.status, run.conclusion);
  return {
    executionId,
    kind: githubRunKind(run.event),
    outcome,
    ...(run.created_at ? { startedAt: run.created_at } : {}),
    ...(run.updated_at ? { endedAt: run.updated_at } : {}),
    state: missingArtifactState(run.status !== "completed", outcome),
    source: "github",
    ...(run.html_url ? { nativeUrl: run.html_url } : {}),
    ref: { executionId, providerId: String(run.id) },
  };
}

function missingArtifactState(
  inProgress: boolean,
  outcome: RunRecord["outcome"],
): RunRecord["state"] {
  if (inProgress) return "in-progress";
  return outcome === "succeeded" ? "upload-failed" : "indeterminate-missing";
}

function linkedGitHubWorkflow(
  artifact: z.infer<typeof githubArtifactSchema>,
  runsById: Map<string, z.infer<typeof githubRunsSchema>["workflow_runs"][number]>,
) {
  if (!artifact.workflow_run) return {};
  const id = String(artifact.workflow_run.id);
  return { id, run: runsById.get(id) };
}

function setDefined<T, Key extends keyof T>(target: T, key: Key, value: T[Key] | undefined): void {
  if (value !== undefined) target[key] = value;
}

function syntheticExecutionId(source: string, providerId: unknown): string {
  return createHash("sha256")
    .update(`${source}:${String(providerId)}`)
    .digest("hex")
    .slice(0, 32);
}
