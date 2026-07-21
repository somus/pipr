import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DownloadedBundle, RunArchiveSource, RunQuery, RunRecord, RunRef } from "./archive.js";
import { extractRunArchive } from "./archive-extraction.js";
import { resolveBitbucketCollectionPageUrl } from "./bitbucket-url.js";
import { PartialRunArchiveListError } from "./partial-list-error.js";
import { maximumRunBundleBytes } from "./types.js";

type ProviderSourceOptions = {
  repository: string;
  token?: string;
  fetch?: ProviderFetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

type ProviderClient = {
  fetch: ProviderFetch;
  headers: Record<string, string>;
  origin: string;
  sleep: (milliseconds: number) => Promise<void>;
};

type ProviderFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

abstract class DownloadableRunArchiveSource implements RunArchiveSource {
  constructor(protected readonly client: ProviderClient) {}

  abstract list(query: RunQuery): Promise<RunRecord[]>;

  async download(ref: RunRef, destination: string): Promise<DownloadedBundle> {
    return await downloadProviderArchive(this.client, ref, destination);
  }
}

const pullRequestArtifactPattern = /^pipr-run-v1-pr-(\d+)-([a-f0-9]{32})(?:\.(zip|tar\.gz))?$/;
const genericArtifactPattern = /^pipr-run-v1-([a-f0-9]{32})(?:\.(zip|tar\.gz))?$/;

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

export class GitHubRunArchiveSource extends DownloadableRunArchiveSource {
  private readonly apiBaseUrl: string;
  private readonly options: ProviderSourceOptions & { apiBaseUrl?: string };

  constructor(options: ProviderSourceOptions & { apiBaseUrl?: string }) {
    super(
      providerClient(
        options,
        {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        options.apiBaseUrl ?? "https://api.github.com",
      ),
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
      source: "github",
      ref: {
        executionId: identity.executionId,
        providerId: String(artifact.id),
        archiveUrl:
          artifact.archive_download_url ??
          `${this.apiBaseUrl}/repos/${this.options.repository}/actions/artifacts/${artifact.id}/zip`,
        archiveFormat: "zip",
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
      const response: Response = await providerRequest(this.client, url);
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
      const response: Response = await providerRequest(this.client, url);
      runs.push(...githubRunsSchema.parse(await response.json()).workflow_runs);
      url = nextLink(response.headers.get("link"));
    }
    return runs.filter(
      (run) => run.name?.toLowerCase() === "pipr" || /(?:^|\/)pipr\.ya?ml$/i.test(run.path ?? ""),
    );
  }
}

const gitlabPipelineSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  web_url: z.string().url().optional(),
});
const gitlabJobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  status: z.string(),
  created_at: z.string().optional(),
  finished_at: z.string().nullable().optional(),
  web_url: z.string().url().optional(),
  artifacts_expire_at: z.string().nullable().optional(),
  artifacts_file: z.object({ filename: z.string().optional() }).nullable().optional(),
});

export class GitLabRunArchiveSource extends DownloadableRunArchiveSource {
  private readonly apiBaseUrl: string;
  private readonly project: string;

  constructor(options: ProviderSourceOptions & { apiBaseUrl?: string }) {
    super(
      providerClient(
        options,
        {
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        options.apiBaseUrl ?? "https://gitlab.com/api/v4",
      ),
    );
    this.apiBaseUrl = options.apiBaseUrl ?? "https://gitlab.com/api/v4";
    this.project = encodeURIComponent(options.repository);
  }

  // fallow-ignore-next-line unused-class-member -- invoked through the RunArchiveSource interface
  async list(query: RunQuery): Promise<RunRecord[]> {
    const records =
      query.changeNumber === undefined
        ? await this.projectJobRecords()
        : await this.mergeRequestJobRecords(query.changeNumber);
    return finalizeRecords(records, query);
  }

  private async projectJobRecords(): Promise<RunRecord[]> {
    const jobs = await this.paginatedArray(
      `${this.apiBaseUrl}/projects/${this.project}/jobs?per_page=100&page=1`,
      gitlabJobSchema,
    );
    return await this.recordsForJobs(jobs);
  }

  private async mergeRequestJobRecords(changeNumber: number): Promise<RunRecord[]> {
    const records: RunRecord[] = [];
    const pipelines = await this.paginatedArray(
      `${this.apiBaseUrl}/projects/${this.project}/merge_requests/${changeNumber}/pipelines?per_page=100&page=1`,
      gitlabPipelineSchema,
    );
    for (const pipeline of pipelines) {
      const jobs = await this.paginatedArray(
        `${this.apiBaseUrl}/projects/${this.project}/pipelines/${pipeline.id}/jobs?include_retried=true&per_page=100&page=1`,
        gitlabJobSchema,
      );
      records.push(...(await this.recordsForJobs(jobs, changeNumber, pipeline)));
    }
    return records;
  }

  private async recordsForJobs(
    jobs: z.infer<typeof gitlabJobSchema>[],
    changeNumber?: number,
    missingRun?: z.infer<typeof gitlabPipelineSchema>,
  ): Promise<RunRecord[]> {
    const records: RunRecord[] = [];
    for (const job of jobs.filter((candidate) => candidate.name === "pipr")) {
      const record = await this.recordForJob(job, changeNumber, missingRun);
      if (record) records.push(record);
    }
    return records;
  }

  private async recordForJob(
    job: z.infer<typeof gitlabJobSchema>,
    changeNumber?: number,
    missingRun?: z.infer<typeof gitlabPipelineSchema>,
  ): Promise<RunRecord | undefined> {
    const identity = parseArtifactName(job.artifacts_file?.filename, changeNumber);
    if (identity) return this.jobRecord(job, identity);
    if (!job.artifacts_file?.filename) {
      return missingRun ? missingProviderRecord("gitlab", missingRun, job) : undefined;
    }
    const manifest = await this.inspectJob(job.id);
    if (manifest && manifestMatchesChange(manifest, changeNumber)) {
      return this.jobRecord(job, { executionId: manifest.executionId }, manifest.kind);
    }
    return missingRun ? missingProviderRecord("gitlab", missingRun, job) : undefined;
  }

  private async inspectJob(jobId: string | number) {
    return await inspectProviderArchive(
      this.client,
      `${this.apiBaseUrl}/projects/${this.project}/jobs/${jobId}/artifacts`,
      "zip",
    ).catch(() => undefined);
  }

  private async paginatedArray<T>(url: string, schema: z.ZodType<T>): Promise<T[]> {
    const values: T[] = [];
    let next: string | undefined = url;
    while (next) {
      const response: Response = await providerRequest(this.client, next);
      values.push(...z.array(schema).parse(await response.json()));
      const nextPage = response.headers.get("x-next-page");
      next = nextPage ? withQuery(next, "page", nextPage) : undefined;
    }
    return values;
  }

  private jobRecord(
    job: z.infer<typeof gitlabJobSchema>,
    identity: ArtifactIdentity,
    kind: RunRecord["kind"] = "review",
  ): RunRecord {
    return {
      executionId: identity.executionId,
      kind,
      outcome: gitlabOutcome(job.status),
      ...(job.created_at ? { startedAt: job.created_at } : {}),
      ...(job.finished_at ? { endedAt: job.finished_at } : {}),
      state: isExpired(job.artifacts_expire_at) ? "expired" : "available",
      source: "gitlab",
      ...(job.web_url ? { nativeUrl: job.web_url } : {}),
      ref: {
        executionId: identity.executionId,
        providerId: String(job.id),
        archiveUrl: `${this.apiBaseUrl}/projects/${this.project}/jobs/${job.id}/artifacts`,
        archiveFormat: "zip",
      },
    };
  }
}

const azureBuildSchema = z.object({
  id: z.union([z.number(), z.string()]),
  status: z.string(),
  result: z.string().nullable().optional(),
  queueTime: z.string().optional(),
  finishTime: z.string().nullable().optional(),
  repository: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
  definition: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      name: z.string().optional(),
      path: z.string().optional(),
    })
    .optional(),
  _links: z.object({ web: z.object({ href: z.string().url().optional() }).optional() }).optional(),
});
const azureArtifactSchema = z.object({
  id: z.union([z.number(), z.string()]),
  name: z.string(),
  resource: z.object({ downloadUrl: z.string().url().optional() }),
});

export class AzureDevOpsRunArchiveSource extends DownloadableRunArchiveSource {
  private readonly apiBaseUrl: string;
  private readonly organization: string;
  private readonly project: string;
  private readonly repository: string;

  constructor(
    options: ProviderSourceOptions & {
      apiBaseUrl?: string;
      authScheme?: "basic" | "bearer";
    },
  ) {
    const authorization = options.token
      ? options.authScheme === "bearer"
        ? `Bearer ${options.token}`
        : `Basic ${Buffer.from(`:${options.token}`).toString("base64")}`
      : undefined;
    super(
      providerClient(
        options,
        {
          ...(authorization ? { Authorization: authorization } : {}),
        },
        options.apiBaseUrl ?? "https://dev.azure.com",
      ),
    );
    [this.organization, this.project, this.repository] = splitRepository(options.repository, 3);
    this.apiBaseUrl = options.apiBaseUrl ?? "https://dev.azure.com";
  }

  // fallow-ignore-next-line unused-class-member -- invoked through the RunArchiveSource interface
  async list(query: RunQuery): Promise<RunRecord[]> {
    const builds = (await this.listBuilds(query.changeNumber)).filter((build) =>
      [build.repository?.id, build.repository?.name].includes(this.repository),
    );
    const records = await Promise.all(
      builds.map((build) => this.recordsForBuild(build, query.changeNumber)),
    );
    return finalizeRecords(records.flat(), query);
  }

  private async listBuilds(changeNumber: number | undefined) {
    const url = this.buildsUrl(changeNumber);
    const builds: z.infer<typeof azureBuildSchema>[] = [];
    for (;;) {
      const buildsResponse = await providerRequest(this.client, url.toString());
      builds.push(
        ...z.object({ value: z.array(azureBuildSchema) }).parse(await buildsResponse.json()).value,
      );
      const continuation = buildsResponse.headers.get("x-ms-continuationtoken");
      if (!continuation) break;
      url.searchParams.set("continuationToken", continuation);
    }
    return builds;
  }

  private buildsUrl(changeNumber: number | undefined): URL {
    const url = new URL(
      `${this.apiBaseUrl}/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_apis/build/builds`,
    );
    const parameters: Record<string, string> = {
      reasonFilter: "pullRequest",
      queryOrder: "queueTimeDescending",
      $top: "100",
      "api-version": "7.1",
    };
    if (changeNumber !== undefined) parameters.branchName = `refs/pull/${changeNumber}/merge`;
    for (const [name, value] of Object.entries(parameters)) url.searchParams.set(name, value);
    return url;
  }

  private async recordsForBuild(
    build: z.infer<typeof azureBuildSchema>,
    changeNumber: number | undefined,
  ): Promise<RunRecord[]> {
    const response = await providerRequest(
      this.client,
      `${this.apiBaseUrl}/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_apis/build/builds/${build.id}/artifacts?api-version=7.1`,
    );
    const artifacts = z
      .object({ value: z.array(azureArtifactSchema) })
      .parse(await response.json()).value;
    const records = artifacts.flatMap((artifact) => {
      const identity = parseArtifactName(artifact.name, changeNumber);
      return identity ? [azureArtifactRecord(build, artifact, identity)] : [];
    });
    return records.length === 0 && (await this.isPiprBuild(build))
      ? [missingProviderRecord("azure-devops", build)]
      : records;
  }

  private async isPiprBuild(build: z.infer<typeof azureBuildSchema>): Promise<boolean> {
    if (build.definition?.name?.toLowerCase() === "pipr") return true;
    if (build.definition?.id === undefined) return false;
    const response = await providerRequest(
      this.client,
      `${this.apiBaseUrl}/${encodeURIComponent(this.organization)}/${encodeURIComponent(this.project)}/_apis/build/definitions/${build.definition.id}?api-version=7.1`,
    );
    const definition = z
      .object({ process: z.object({ yamlFilename: z.string().optional() }).optional() })
      .parse(await response.json());
    return /(?:^|[\\/])azure-pipelines\.pipr\.ya?ml$/i.test(definition.process?.yamlFilename ?? "");
  }
}

const bitbucketDownloadSchema = z.object({
  name: z.string(),
  created_on: z.string().optional(),
  expires_on: z.string().nullable().optional(),
  links: z.object({ self: z.object({ href: z.string().url() }) }),
});
const bitbucketDownloadsSchema = z.object({
  values: z.array(bitbucketDownloadSchema),
  next: z.string().url().optional(),
});
const bitbucketPipelineSchema = z.object({
  uuid: z.string(),
  build_number: z.number().optional(),
  created_on: z.string().optional(),
  completed_on: z.string().nullable().optional(),
  state: z.object({
    name: z.string().optional(),
    result: z.object({ name: z.string().optional() }).optional(),
  }),
  target: z.object({ pullrequest: z.object({ id: z.number() }).optional() }).optional(),
  links: z
    .object({
      html: z.object({ href: z.string().url().optional() }).optional(),
      steps: z.object({ href: z.string().min(1) }).optional(),
    })
    .optional(),
});
const bitbucketPipelinesSchema = z.object({
  values: z.array(bitbucketPipelineSchema),
  next: z.string().url().optional(),
});
const bitbucketStepsSchema = z.object({
  values: z.array(z.object({ name: z.string().optional() })),
  next: z.string().min(1).optional(),
});
const bitbucketBundleStepName = "Pipr review (run bundle v1)";

export class BitbucketRunArchiveSource extends DownloadableRunArchiveSource {
  private readonly apiBaseUrl: string;
  private readonly workspace: string;
  private readonly repository: string;

  constructor(options: ProviderSourceOptions & { email?: string; apiBaseUrl?: string }) {
    const authorization = options.token
      ? options.email
        ? `Basic ${Buffer.from(`${options.email}:${options.token}`).toString("base64")}`
        : `Bearer ${options.token}`
      : undefined;
    super(
      providerClient(
        options,
        authorization ? { Authorization: authorization } : {},
        options.apiBaseUrl ?? "https://api.bitbucket.org",
      ),
    );
    [this.workspace, this.repository] = splitRepository(options.repository, 2);
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.bitbucket.org";
  }

  // fallow-ignore-next-line unused-class-member -- invoked through the RunArchiveSource interface
  async list(query: RunQuery): Promise<RunRecord[]> {
    const changeNumber = query.changeNumber;
    const { downloads, error: downloadError } = await this.downloadsForQuery(changeNumber);
    const records = await this.recordsForDownloads(downloads, changeNumber);
    const pipelines = changeNumber === undefined ? [] : await this.listPipelines(changeNumber);
    const archivedPipelineIds = new Set(
      records.flatMap((record) => (record.ref.providerId ? [record.ref.providerId] : [])),
    );
    records.push(
      ...(await Promise.all(
        pipelines
          .filter((pipeline) => !archivedPipelineIds.has(String(pipeline.uuid)))
          .map((pipeline) => this.pipelineRecord(pipeline)),
      )),
    );
    const finalized = finalizeRecords(records, query);
    if (downloadError !== undefined) {
      const message =
        downloadError instanceof Error ? downloadError.message : "provider lookup failed";
      throw new PartialRunArchiveListError(
        `Bitbucket Downloads lookup failed: ${message}`,
        finalized,
      );
    }
    return finalized;
  }

  private async listDownloads() {
    const collectionUrl = `${this.apiBaseUrl}/2.0/repositories/${encodeURIComponent(this.workspace)}/${encodeURIComponent(this.repository)}/downloads`;
    return await this.listCollection(collectionUrl, bitbucketDownloadsSchema);
  }

  private async recordsForDownloads(
    downloads: z.infer<typeof bitbucketDownloadSchema>[],
    changeNumber: number | undefined,
  ): Promise<RunRecord[]> {
    const records: RunRecord[] = [];
    for (const download of downloads) {
      const identity = parseArtifactName(download.name, changeNumber);
      if (!identity) continue;
      const expired = isExpired(download.expires_on);
      const manifest = expired
        ? undefined
        : await inspectProviderArchive(this.client, download.links.self.href, "tar.gz").catch(
            () => undefined,
          );
      records.push({
        executionId: identity.executionId,
        kind: "review",
        ...(download.created_on ? { startedAt: download.created_on } : {}),
        state: expired ? "expired" : "available",
        source: "bitbucket",
        ref: {
          executionId: identity.executionId,
          ...(manifest?.provider?.runId ? { providerId: manifest.provider.runId } : {}),
          archiveUrl: download.links.self.href,
          archiveFormat: "tar.gz",
        },
      });
    }
    return records;
  }

  private async downloadsForQuery(changeNumber: number | undefined) {
    try {
      return { downloads: await this.listDownloads() };
    } catch (error) {
      if (changeNumber === undefined) throw error;
      return { downloads: [], error };
    }
  }

  private async listPipelines(changeNumber: number) {
    const collectionUrl = `${this.apiBaseUrl}/2.0/repositories/${encodeURIComponent(this.workspace)}/${encodeURIComponent(this.repository)}/pipelines/`;
    const values = await this.listCollection(collectionUrl, bitbucketPipelinesSchema);
    return values.filter((pipeline) => pipeline.target?.pullrequest?.id === changeNumber);
  }

  private async listCollection<T>(
    collectionUrl: string,
    schema: z.ZodType<{ values: T[]; next?: string | undefined }>,
  ): Promise<T[]> {
    const values: T[] = [];
    let url: string | undefined = collectionUrl;
    while (url) {
      const response: Response = await providerRequest(this.client, url);
      const page = schema.parse(await response.json());
      values.push(...page.values);
      url = page.next ? this.collectionUrl(page.next, collectionUrl) : undefined;
    }
    return values;
  }

  private async pipelineRecord(
    pipeline: z.infer<typeof bitbucketPipelineSchema>,
  ): Promise<RunRecord> {
    const record = missingProviderRecord("bitbucket", pipeline);
    if (!record.nativeUrl && pipeline.build_number !== undefined) {
      record.nativeUrl =
        `https://bitbucket.org/${encodeURIComponent(this.workspace)}/` +
        `${encodeURIComponent(this.repository)}/pipelines/results/${pipeline.build_number}`;
    }
    if (
      pipeline.state.name?.toUpperCase() === "COMPLETED" &&
      pipeline.links?.steps?.href &&
      (await this.hasNativeBundleArtifact(pipeline.links.steps.href))
    ) {
      record.state = "available-in-ci";
    }
    return record;
  }

  private async hasNativeBundleArtifact(initialUrl: string): Promise<boolean> {
    let url: string | undefined = this.repositoryApiUrl(initialUrl);
    while (url) {
      const response: Response = await providerRequest(this.client, url);
      const page = bitbucketStepsSchema.parse(await response.json());
      if (page.values.some((step) => step.name === bitbucketBundleStepName)) return true;
      url = page.next ? this.repositoryApiUrl(page.next) : undefined;
    }
    return false;
  }

  private collectionUrl(value: string, collectionUrl: string): string {
    return resolveBitbucketCollectionPageUrl(value, collectionUrl);
  }

  private repositoryApiUrl(value: string): string {
    const base = new URL(this.apiBaseUrl);
    const resolved = new URL(value, base);
    const repositoryPrefix = `/2.0/repositories/${encodeURIComponent(this.workspace)}/${encodeURIComponent(this.repository)}/`;
    if (resolved.origin !== base.origin || !resolved.pathname.startsWith(repositoryPrefix)) {
      throw new Error("Bitbucket API link points outside the configured repository");
    }
    return resolved.toString();
  }
}

async function downloadProviderArchive(
  client: ProviderClient,
  ref: RunRef,
  destination: string,
): Promise<DownloadedBundle> {
  if (!ref.archiveUrl || !ref.archiveFormat) {
    throw new Error(`Run ${ref.executionId} does not have an available provider archive`);
  }
  const response = await providerRequest(client, ref.archiveUrl);
  const archive = await readProviderArchive(response);
  let createdArchivePath: string | undefined;
  try {
    const downloaded = await extractRunArchive({
      archive,
      format: ref.archiveFormat,
      destination,
    });
    if (downloaded.manifest.executionId !== ref.executionId) {
      await rm(destination, { recursive: true, force: true });
      throw new Error("Downloaded run execution ID does not match the provider record");
    }
    if (!ref.preserveArchive) return downloaded;
    const archivePath = `${destination}.${ref.archiveFormat}`;
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

async function inspectProviderArchive(
  client: ProviderClient,
  archiveUrl: string,
  format: "zip" | "tar.gz",
): Promise<DownloadedBundle["manifest"]> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-provider-inspect-"));
  try {
    const response = await providerRequest(client, archiveUrl);
    const downloaded = await extractRunArchive({
      archive: await readProviderArchive(response),
      format,
      destination: path.join(temporaryRoot, "bundle"),
    });
    return downloaded.manifest;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function readProviderArchive(response: Response): Promise<Uint8Array> {
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

function providerClient(
  options: Pick<ProviderSourceOptions, "fetch" | "sleep">,
  headers: Record<string, string>,
  apiBaseUrl: string,
): ProviderClient {
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

async function providerRequest(client: ProviderClient, url: string): Promise<Response> {
  if (new URL(url).origin !== client.origin) {
    throw new Error("Run provider URL points outside the configured provider origin");
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await client.fetch(url, { headers: client.headers, redirect: "follow" });
    if (response.ok) return response;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await client.sleep(retryDelay(response, attempt));
      continue;
    }
    throw new Error(`Run provider request failed with HTTP ${response.status}`);
  }
  throw new Error("Run provider request exhausted retries");
}

function retryDelay(response: Response, attempt: number): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? Math.min(retryAfter * 1000, 5_000)
    : Math.min(250 * 2 ** attempt, 2_000);
}

type ArtifactIdentity = { executionId: string };

function parseArtifactName(
  name: string | undefined,
  expectedChangeNumber?: number,
): ArtifactIdentity | undefined {
  if (!name) return undefined;
  const pullRequestMatch = pullRequestArtifactPattern.exec(name);
  if (pullRequestMatch) {
    if (
      expectedChangeNumber !== undefined &&
      Number(pullRequestMatch[1]) !== expectedChangeNumber
    ) {
      return undefined;
    }
    return { executionId: pullRequestMatch[2] };
  }
  if (expectedChangeNumber !== undefined) return undefined;
  const genericMatch = genericArtifactPattern.exec(name);
  return genericMatch ? { executionId: genericMatch[1] } : undefined;
}

function nextLink(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(",")) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
    if (match) return match[1];
  }
  return undefined;
}

function withQuery(url: string, name: string, value: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set(name, value);
  return parsed.toString();
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

function gitlabOutcome(status: string): RunRecord["outcome"] {
  if (status === "success") return "succeeded";
  if (status === "running" || status === "pending" || status === "created") return "in-progress";
  return "failed";
}

function azureOutcome(status: string, result: string | null | undefined): RunRecord["outcome"] {
  if (status !== "completed") return "in-progress";
  return result === "succeeded" || result === "partiallySucceeded" ? "succeeded" : "failed";
}

function missingProviderRecord(
  source: RunRecord["source"],
  run: Record<string, unknown>,
  job?: Record<string, unknown>,
): RunRecord {
  const details = missingProviderDetails(run, job);
  const inProgress = isProviderRunActive(details.status);
  const outcome = missingProviderOutcome(source, run, job, inProgress);
  const executionId = syntheticExecutionId(source, details.providerId);
  const record: RunRecord = {
    executionId,
    kind: "review",
    outcome,
    state: missingArtifactState(inProgress, outcome),
    source,
    ref: { executionId, providerId: details.providerId },
  };
  setDefined(record, "startedAt", details.startedAt);
  setDefined(record, "endedAt", details.endedAt);
  setDefined(record, "nativeUrl", details.nativeUrl);
  return record;
}

function missingProviderOutcome(
  source: RunRecord["source"],
  run: Record<string, unknown>,
  job: Record<string, unknown> | undefined,
  inProgress: boolean,
): RunRecord["outcome"] {
  if (inProgress) return "in-progress";
  const succeeded = {
    gitlab: String(job?.status ?? run.status) === "success",
    "azure-devops": ["succeeded", "partiallySucceeded"].includes(String(run.result ?? "")),
    bitbucket: nestedString(run, "state", "result", "name")?.toUpperCase() === "SUCCESSFUL",
    github: false,
    filesystem: false,
  } satisfies Record<RunRecord["source"], boolean>;
  return succeeded[source] ? "succeeded" : "failed";
}

function missingProviderDetails(run: Record<string, unknown>, job?: Record<string, unknown>) {
  const jobRecord = job ?? {};
  return {
    providerId: String(firstDefined([jobRecord.id, run.id, run.uuid, "unknown"])),
    status: String(
      firstDefined([jobRecord.status, run.status, nestedString(run, "state", "name"), "unknown"]),
    ),
    startedAt: optionalString(
      firstDefined([jobRecord.created_at, run.created_at, run.queueTime, run.created_on]),
    ),
    endedAt: optionalString(
      firstDefined([jobRecord.finished_at, run.updated_at, run.finishTime, run.completed_on]),
    ),
    nativeUrl: optionalString(
      firstDefined([
        jobRecord.web_url,
        run.web_url,
        nestedString(run, "_links", "web", "href"),
        nestedString(run, "links", "html", "href"),
      ]),
    ),
  };
}

function firstDefined(values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function linkedGitHubWorkflow(
  artifact: z.infer<typeof githubArtifactSchema>,
  runsById: Map<string, z.infer<typeof githubRunsSchema>["workflow_runs"][number]>,
) {
  if (!artifact.workflow_run) return {};
  const id = String(artifact.workflow_run.id);
  return { id, run: runsById.get(id) };
}

function isProviderRunActive(status: string): boolean {
  return ["running", "pending", "created", "inprogress", "in_progress"].includes(
    status.toLowerCase(),
  );
}

function manifestMatchesChange(
  manifest: DownloadedBundle["manifest"],
  changeNumber: number | undefined,
): boolean {
  return changeNumber === undefined || manifest.repository?.changeNumber === changeNumber;
}

function azureArtifactRecord(
  build: z.infer<typeof azureBuildSchema>,
  artifact: z.infer<typeof azureArtifactSchema>,
  identity: ArtifactIdentity,
): RunRecord {
  const record: RunRecord = {
    executionId: identity.executionId,
    kind: "review",
    outcome: azureOutcome(build.status, build.result),
    state: "available",
    source: "azure-devops",
    ref: {
      executionId: identity.executionId,
      providerId: String(artifact.id),
      archiveFormat: "zip",
    },
  };
  setDefined(record, "startedAt", build.queueTime);
  setDefined(record, "endedAt", build.finishTime ?? undefined);
  setDefined(record, "nativeUrl", build._links?.web?.href);
  setDefined(record.ref, "archiveUrl", artifact.resource.downloadUrl);
  return record;
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

function isExpired(value: string | null | undefined): boolean {
  return Boolean(value && Date.parse(value) <= Date.now());
}

function splitRepository(value: string, expectedParts: number): string[] {
  const parts = value.split("/").filter(Boolean);
  if (parts.length !== expectedParts) {
    throw new Error(`Provider repository must contain ${expectedParts} path segments`);
  }
  return parts;
}

function nestedString(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return optionalString(current);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
