import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  AzureDevOpsRunArchiveSource,
  BitbucketRunArchiveSource,
  diagnoseRunBundle,
  FileSystemRunArchiveSource,
  GitHubRunArchiveSource,
  GitLabRunArchiveSource,
  PartialRunArchiveListError,
  type RunArchiveSource,
  type RunQuery,
  type RunRecord,
} from "@usepipr/runtime";

export type RunSelector = {
  host: "github" | "gitlab" | "azure-devops" | "bitbucket";
  repository: string;
  changeNumber: number;
};

export type RunsListOptions = {
  pr: string;
  host?: string;
  repository?: string;
  kind?: string;
  status?: string;
  limit?: string;
  json?: boolean;
  store?: string;
};

export type RunsShowOptions = Omit<RunsListOptions, "pr"> & {
  pr?: string;
  timeline?: boolean;
};

export type RunsDownloadOptions = {
  host?: string;
  repository?: string;
  output?: string;
  archive?: boolean;
  store?: string;
};

export async function runRunsList(
  options: RunsListOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const selector = await resolveRunSelector({ ...options, cwd: context.cwd });
  const collected = await collectRecords(await runSources(options.store, context, selector), {
    ...selector,
    kind: parseKind(options.kind, "all"),
    ...(options.status ? { status: parseStatus(options.status) } : {}),
    limit: parseLimit(options.limit),
  });
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          formatVersion: 1,
          runs: collected.records.map(publicRunRecord),
          errors: collected.errors,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const error of collected.errors)
    console.error(`pipr warning ${error.source}: ${error.message}`);
  printRunList(collected.records);
}

export async function runRunsShow(
  executionId: string | undefined,
  options: RunsShowOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  requireShowSelector(executionId, options.pr);
  const selector = await showRepositorySelector(options, context.cwd);
  const sources = await runSources(options.store, context, selector);
  const selected = await selectRunForShow(executionId, options, selector, sources);
  const resolvedExecutionId = validExecutionId(executionId ?? selected.executionId);
  requireAvailableRun(selected, resolvedExecutionId);
  await renderSelectedRun(selected, resolvedExecutionId, options);
}

function requireShowSelector(executionId: string | undefined, pr: string | undefined): void {
  if (!executionId && !pr) throw new Error("Provide an execution ID or --pr <number|URL>");
}

async function showRepositorySelector(
  options: RunsShowOptions,
  cwd: string,
): Promise<Omit<RunSelector, "changeNumber"> | RunSelector | undefined> {
  if (options.pr) return await resolveRunSelector({ ...options, pr: options.pr, cwd });
  return await resolveRepositorySelector({ ...options, cwd }).catch(() => undefined);
}

async function selectRunForShow(
  executionId: string | undefined,
  options: RunsShowOptions,
  selector: Omit<RunSelector, "changeNumber"> | RunSelector | undefined,
  sources: SourceEntry[],
): Promise<CollectedRecord> {
  if (executionId) return await selectRunByExecutionId(executionId, sources);
  if (!options.pr || !selector || !("changeNumber" in selector)) {
    throw new Error("A PR selector is required when no execution ID is provided");
  }
  const collected = await collectRecords(sources, {
    ...selector,
    kind: parseKind(options.kind, "review"),
    limit: 100,
  });
  const selected = collected.records.find(isCompletedAvailableRun);
  if (selected) return selected;
  const nativeCiArtifact = collected.records.find(
    (record) => record.state === "available-in-ci" && record.outcome !== "in-progress",
  );
  if (nativeCiArtifact) return nativeCiArtifact;
  throw new Error(
    withLookupErrors("No completed Pipr run matched the PR selector", collected.errors),
  );
}

async function selectRunByExecutionId(
  executionId: string,
  sources: SourceEntry[],
): Promise<CollectedRecord> {
  const validId = validExecutionId(executionId);
  const collected = await collectRecords(sources, {
    executionId: validId,
    kind: "all",
    limit: 1000,
  });
  const selected = collected.records.find((record) => record.executionId === validId);
  if (selected) return selected;
  throw new Error(
    withLookupErrors(
      `Pipr run ${validId} was not found in local or provider storage`,
      collected.errors,
    ),
  );
}

function isCompletedAvailableRun(record: CollectedRecord): boolean {
  return record.state === "available" && record.outcome !== "in-progress";
}

function validExecutionId(executionId: string): string {
  if (!/^[a-f0-9]{32}$/.test(executionId)) {
    throw new Error("Execution ID must be a 32-character lowercase hexadecimal trace ID");
  }
  return executionId;
}

function requireAvailableRun(selected: CollectedRecord, executionId: string): void {
  if (selected.state !== "available") {
    throw new Error(unavailableRunMessage(selected, executionId));
  }
}

function unavailableRunMessage(selected: RunRecord, executionId: string): string {
  if (selected.state === "available-in-ci" && selected.nativeUrl) {
    return `Pipr run ${executionId} is available in native CI artifacts at ${selected.nativeUrl}; automated download is unavailable`;
  }
  return `Pipr run ${executionId} is ${selected.state} and cannot be downloaded`;
}

async function renderSelectedRun(
  selected: CollectedRecord,
  executionId: string,
  options: RunsShowOptions,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runs-show-"));
  try {
    const downloaded = await selected.archiveSource.download(
      selected.ref,
      path.join(temporaryRoot, executionId),
    );
    const { loadValidatedRunBundle } = await import("@usepipr/runtime");
    const bundle = await loadValidatedRunBundle(downloaded.directory);
    const diagnosis = diagnoseRunBundle(bundle);
    if (options.json) return printRunJson(bundle, diagnosis);
    printDiagnosis(bundle.manifest, diagnosis, options.timeline ? bundle.spans : undefined);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function printRunJson(
  bundle: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>,
  diagnosis: ReturnType<typeof diagnoseRunBundle>,
): void {
  console.log(
    JSON.stringify(
      {
        formatVersion: 1,
        manifest: bundle.manifest,
        spans: bundle.spans,
        diagnosis,
        artifacts: bundle.manifest.artifacts,
      },
      null,
      2,
    ),
  );
}

export async function runRunsDownload(
  executionId: string,
  options: RunsDownloadOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(executionId)) {
    throw new Error("Execution ID must be a 32-character lowercase hexadecimal trace ID");
  }
  const destination = path.resolve(context.cwd, options.output ?? `pipr-run-${executionId}`);
  const selector = await resolveRepositorySelector({ ...options, cwd: context.cwd }).catch(
    () => undefined,
  );
  const collected = await collectRecords(await runSources(options.store, context, selector), {
    executionId,
    kind: "all",
    limit: 1000,
  });
  const selected = collected.records.find((record) => record.executionId === executionId);
  if (!selected) {
    throw new Error(
      withLookupErrors(
        `Pipr run ${executionId} was not found in local or provider storage`,
        collected.errors,
      ),
    );
  }
  if (selected.state !== "available") {
    throw new Error(unavailableRunMessage(selected, executionId));
  }
  const downloaded = await selected.archiveSource.download(
    { ...selected.ref, preserveArchive: options.archive },
    destination,
  );
  console.log(downloaded.directory);
  if (downloaded.archivePath) console.log(downloaded.archivePath);
}

export async function resolveRunSelector(options: {
  pr: string;
  host?: string;
  repository?: string;
  cwd: string;
}): Promise<RunSelector> {
  const changeNumber = parseChangeNumber(options.pr);
  let discovered: Omit<RunSelector, "changeNumber"> | undefined;
  if (changeNumber === undefined) discovered = selectorFromUrl(options.pr);
  if (!discovered && (!options.host || !options.repository)) {
    discovered = await selectorFromGitRemote(options.cwd);
  }
  const host = options.host ? parseHost(options.host) : discovered?.host;
  const repository = options.repository ?? discovered?.repository;
  const resolvedChangeNumber = changeNumber ?? selectorFromUrl(options.pr)?.changeNumber;
  if (!host || !repository || !resolvedChangeNumber) {
    throw new Error(
      "Could not derive the PR host and repository; pass a PR URL or --host and --repository",
    );
  }
  return { host, repository, changeNumber: resolvedChangeNumber };
}

export async function defaultLocalTraceStore(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const remote = await selectorFromGitRemote(cwd).catch(() => undefined);
  const identity = remote?.repository ?? path.basename(cwd);
  const partition = `${identity.replace(/[^a-z0-9._-]+/gi, "-")}-${createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 12)}`;
  const stateRoot = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "pipr")
    : process.platform === "darwin" && env.HOME
      ? path.join(env.HOME, "Library", "Application Support", "pipr")
      : path.join(env.HOME ?? os.homedir(), ".local", "state", "pipr");
  return path.join(stateRoot, "runs", partition);
}

async function resolveRepositorySelector(options: {
  host?: string;
  repository?: string;
  cwd: string;
}): Promise<Omit<RunSelector, "changeNumber">> {
  const discovered = await selectorFromGitRemote(options.cwd);
  const host = options.host ? parseHost(options.host) : discovered?.host;
  const repository = options.repository ?? discovered?.repository;
  if (!host || !repository) {
    throw new Error("Could not derive the code host and repository");
  }
  return { host, repository };
}

function localSource(
  store: string,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): FileSystemRunArchiveSource {
  return new FileSystemRunArchiveSource(path.resolve(context.cwd, store));
}

type SourceEntry = {
  name: RunRecord["source"];
  archiveSource: RunArchiveSource;
};

type CollectedRecord = RunRecord & { archiveSource: RunArchiveSource };

function publicRunRecord(record: CollectedRecord): RunRecord {
  const { archiveSource: _, ...publicRecord } = record;
  return publicRecord;
}

async function runSources(
  store: string | undefined,
  context: { env: NodeJS.ProcessEnv; cwd: string },
  selector?: Omit<RunSelector, "changeNumber">,
): Promise<SourceEntry[]> {
  const configuredStore = store ?? context.env.PIPR_RUN_STORE_DIR;
  const localStores = configuredStore
    ? [path.resolve(context.cwd, configuredStore)]
    : [
        path.resolve(context.cwd, ".pipr-runs"),
        await defaultLocalTraceStore(context.cwd, context.env),
      ];
  const sources: SourceEntry[] = [...new Set(localStores)].map((localStore) => ({
    name: "filesystem",
    archiveSource: localSource(localStore, context),
  }));
  if (!selector) return sources;
  const remote = providerSource(selector, context.env);
  sources.push({ name: selector.host, archiveSource: remote });
  return sources;
}

function providerSource(
  selector: Omit<RunSelector, "changeNumber">,
  env: NodeJS.ProcessEnv,
): RunArchiveSource {
  switch (selector.host) {
    case "github":
      return githubSource(selector.repository, env);
    case "gitlab":
      return gitlabSource(selector.repository, env);
    case "azure-devops":
      return azureSource(selector.repository, env);
    case "bitbucket":
      return bitbucketSource(selector.repository, env);
  }
}

function githubSource(repository: string, env: NodeJS.ProcessEnv): RunArchiveSource {
  const token = env.PIPR_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  if (!token) return missingCredentialSource("GitHub", "PIPR_GITHUB_TOKEN or GITHUB_TOKEN");
  return new GitHubRunArchiveSource({
    repository,
    token,
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });
}

function gitlabSource(repository: string, env: NodeJS.ProcessEnv): RunArchiveSource {
  const token = env.PIPR_GITLAB_TOKEN ?? env.GITLAB_TOKEN;
  if (!token) return missingCredentialSource("GitLab", "PIPR_GITLAB_TOKEN or GITLAB_TOKEN");
  return new GitLabRunArchiveSource({
    repository,
    token,
    ...(env.CI_API_V4_URL ? { apiBaseUrl: env.CI_API_V4_URL } : {}),
  });
}

function azureSource(repository: string, env: NodeJS.ProcessEnv): RunArchiveSource {
  const pat = env.PIPR_AZURE_DEVOPS_TOKEN ?? env.AZURE_DEVOPS_TOKEN;
  const token = pat ?? env.SYSTEM_ACCESSTOKEN;
  if (!token) {
    return missingCredentialSource(
      "Azure DevOps",
      "PIPR_AZURE_DEVOPS_TOKEN, AZURE_DEVOPS_TOKEN, or SYSTEM_ACCESSTOKEN",
    );
  }
  return new AzureDevOpsRunArchiveSource({
    repository,
    token,
    authScheme: pat ? "basic" : "bearer",
  });
}

function bitbucketSource(repository: string, env: NodeJS.ProcessEnv): RunArchiveSource {
  const token = env.PIPR_BITBUCKET_TOKEN ?? env.BITBUCKET_API_TOKEN;
  if (!token) {
    return missingCredentialSource("Bitbucket", "PIPR_BITBUCKET_TOKEN or BITBUCKET_API_TOKEN");
  }
  return new BitbucketRunArchiveSource({ repository, token, email: env.BITBUCKET_EMAIL });
}

function missingCredentialSource(provider: string, variables: string): RunArchiveSource {
  const message = `${provider} run retrieval requires ${variables}`;
  return {
    async list() {
      throw new Error(message);
    },
    async download() {
      throw new Error(message);
    },
  };
}

async function collectRecords(
  sources: SourceEntry[],
  query: RunQuery,
): Promise<{
  records: CollectedRecord[];
  errors: Array<{ source: RunRecord["source"]; message: string }>;
}> {
  const settled = await Promise.allSettled(
    sources.map(async (source) => ({ source, records: await source.archiveSource.list(query) })),
  );
  const errors: Array<{ source: RunRecord["source"]; message: string }> = [];
  const byExecutionId = new Map<string, CollectedRecord>();
  const collectSourceRecords = (source: SourceEntry, records: RunRecord[]) => {
    for (const record of records) {
      const collected = { ...record, archiveSource: source.archiveSource };
      const existing = byExecutionId.get(record.executionId);
      if (!existing || recordPreference(collected) > recordPreference(existing)) {
        byExecutionId.set(record.executionId, collected);
      }
    }
  };
  for (const [index, result] of settled.entries()) {
    const source = sources[index];
    if (!source) continue;
    if (result.status === "rejected") {
      errors.push({
        source: source.name,
        message: result.reason instanceof Error ? result.reason.message : "provider lookup failed",
      });
    }
    const records =
      result.status === "fulfilled"
        ? result.value.records
        : result.reason instanceof PartialRunArchiveListError
          ? result.reason.records
          : [];
    collectSourceRecords(source, records);
  }
  return {
    records: [...byExecutionId.values()]
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
      .slice(0, query.limit ?? 20),
    errors,
  };
}

function recordPreference(record: CollectedRecord): number {
  const availability =
    record.state === "available"
      ? 10
      : record.state === "available-in-ci"
        ? 7
        : record.state === "in-progress"
          ? 5
          : 0;
  return availability + (record.source === "filesystem" ? 1 : 0);
}

function withLookupErrors(
  message: string,
  errors: Array<{ source: RunRecord["source"]; message: string }>,
): string {
  return errors.length === 0
    ? message
    : `${message}; ${errors.map((error) => `${error.source}: ${error.message}`).join("; ")}`;
}

function selectorFromUrl(value: string): RunSelector | undefined {
  const url = parseUrl(value);
  if (!url) return undefined;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const parsers = [githubUrlSelector, gitlabUrlSelector, azureUrlSelector, bitbucketUrlSelector];
  return parsers.map((parse) => parse(url, parts)).find((result) => result !== undefined);
}

type UrlSelectorParser = (url: URL, parts: string[]) => RunSelector | undefined;

const githubUrlSelector: UrlSelectorParser = (url, parts) => {
  if (url.hostname !== "github.com") return undefined;
  const pull = parts.indexOf("pull");
  return pull >= 2
    ? selector("github", parts.slice(0, pull).join("/"), parts[pull + 1])
    : undefined;
};

const gitlabUrlSelector: UrlSelectorParser = (_url, parts) => {
  const mergeRequests = parts.indexOf("merge_requests");
  if (mergeRequests < 2 || parts[mergeRequests - 1] !== "-") return undefined;
  return selector("gitlab", parts.slice(0, mergeRequests - 1).join("/"), parts[mergeRequests + 1]);
};

const azureUrlSelector: UrlSelectorParser = (_url, parts) => {
  const pullRequest = parts.indexOf("pullrequest");
  const git = parts.indexOf("_git");
  if (pullRequest <= git || git < 2) return undefined;
  return selector(
    "azure-devops",
    `${parts[0]}/${parts[1]}/${parts[git + 1]}`,
    parts[pullRequest + 1],
  );
};

const bitbucketUrlSelector: UrlSelectorParser = (url, parts) => {
  const bitbucketPull = parts.indexOf("pull-requests");
  if (url.hostname !== "bitbucket.org" || bitbucketPull < 2) return undefined;
  return selector("bitbucket", parts.slice(0, bitbucketPull).join("/"), parts[bitbucketPull + 1]);
};

async function selectorFromGitRemote(
  cwd: string,
): Promise<Omit<RunSelector, "changeNumber"> | undefined> {
  const child = Bun.spawn(["git", "config", "--get", "remote.origin.url"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  if (exitCode !== 0) return undefined;
  return selectorFromRemote(stdout.trim());
}

function selectorFromRemote(value: string): Omit<RunSelector, "changeNumber"> | undefined {
  if (!value) return undefined;
  const azureSsh = azureSshRemoteSelector(value);
  if (azureSsh) return azureSsh;
  const url = parseUrl(normalizeGitRemote(value));
  return url ? selectorFromRemoteUrl(url) : undefined;
}

function azureSshRemoteSelector(value: string): Omit<RunSelector, "changeNumber"> | undefined {
  const prefix = "git@ssh.dev.azure.com:v3/";
  if (!value.startsWith(prefix)) return undefined;
  const [organization, project, repository] = value
    .slice(prefix.length)
    .replace(/\.git$/, "")
    .split("/");
  return organization && project && repository
    ? { host: "azure-devops", repository: `${organization}/${project}/${repository}` }
    : undefined;
}

function normalizeGitRemote(value: string): string {
  return value.match(/^git@([^:]+):(.+)$/)
    ? `https://${value.replace(/^git@/, "").replace(":", "/")}`
    : value;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function selectorFromRemoteUrl(url: URL): Omit<RunSelector, "changeNumber"> | undefined {
  const repository = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
  if (!repository) return undefined;
  if (url.hostname === "github.com") return { host: "github", repository };
  if (url.hostname === "bitbucket.org") return { host: "bitbucket", repository };
  if (url.hostname.includes("gitlab")) return { host: "gitlab", repository };
  return url.hostname.includes("dev.azure.com") ? azureRemoteUrlSelector(repository) : undefined;
}

function azureRemoteUrlSelector(repository: string): Omit<RunSelector, "changeNumber"> | undefined {
  const parts = repository.split("/");
  const git = parts.indexOf("_git");
  return git >= 2 && parts[git + 1]
    ? { host: "azure-devops", repository: `${parts[0]}/${parts[1]}/${parts[git + 1]}` }
    : undefined;
}

function selector(
  host: RunSelector["host"],
  repository: string,
  number: string | undefined,
): RunSelector | undefined {
  const changeNumber = parseChangeNumber(number ?? "");
  return changeNumber ? { host, repository, changeNumber } : undefined;
}

function parseChangeNumber(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

function parseHost(value: string): RunSelector["host"] {
  if (
    value === "github" ||
    value === "gitlab" ||
    value === "azure-devops" ||
    value === "bitbucket"
  ) {
    return value;
  }
  throw new Error(`Unsupported run host '${value}'`);
}

function parseKind(value: string | undefined, fallback: RunQuery["kind"]): RunQuery["kind"] {
  const kind = value ?? fallback;
  if (
    kind === "review" ||
    kind === "command" ||
    kind === "verifier" ||
    kind === "startup" ||
    kind === "all"
  ) {
    return kind;
  }
  throw new Error(`Unsupported run kind '${kind}'`);
}

function parseStatus(value: string): NonNullable<RunQuery["status"]> {
  const statuses = new Set([
    "available",
    "available-in-ci",
    "in-progress",
    "expired",
    "capture-failed",
    "upload-failed",
    "not-enabled",
    "indeterminate-missing",
    "succeeded",
    "failed",
    "partial",
  ]);
  if (!statuses.has(value)) throw new Error(`Unsupported run status '${value}'`);
  return value as NonNullable<RunQuery["status"]>;
}

function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? "20");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }
  return limit;
}

function printRunList(runs: RunRecord[]): void {
  if (runs.length === 0) {
    console.log("No Pipr runs found.");
    return;
  }
  console.log(
    "EXECUTION ID                     KIND      OUTCOME      STATE            STARTED                   LOCATION",
  );
  for (const run of runs) {
    console.log(
      [
        run.executionId.padEnd(32),
        (run.kind ?? "unknown").padEnd(9),
        (run.outcome ?? "unknown").padEnd(12),
        run.state.padEnd(16),
        (run.startedAt ?? "unknown").padEnd(25),
        run.nativeUrl ?? "-",
      ].join("  "),
    );
  }
}

function printDiagnosis(
  manifest: Awaited<
    ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>
  >["manifest"],
  diagnosis: ReturnType<typeof diagnoseRunBundle>,
  timeline?: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>["spans"],
): void {
  console.log(`Execution: ${manifest.executionId}`);
  console.log(`Kind: ${manifest.kind}`);
  console.log(`Outcome: ${manifest.outcome}`);
  console.log(`Duration: ${manifest.durationMs ?? 0}ms`);
  console.log(`Model retries: ${diagnosis.modelRetryAttempts}`);
  console.log(`Agent retries: ${diagnosis.agentRetryAttempts}`);
  console.log(
    `Backoff: ${diagnosis.backoffDurationsMs.length > 0 ? `${diagnosis.backoffDurationsMs.join(", ")}ms` : "none"}`,
  );
  console.log(`Repairs: ${diagnosis.repairAttempts}`);
  console.log(`Validation drops: ${diagnosis.validationDrops}`);
  console.log(`Publication failures: ${diagnosis.publicationFailures}`);
  printDurations("Critical path", diagnosis.criticalPath);
  printDurations("Phase durations", diagnosis.phaseDurations);
  printDurations("Tool durations", diagnosis.toolDurations);
  console.log(
    `Usage: ${diagnosis.usage.inputTokens} input, ${diagnosis.usage.outputTokens} output, $${diagnosis.usage.costUsd}`,
  );
  const cpuMs = (diagnosis.resources.cpuUserMs ?? 0) + (diagnosis.resources.cpuSystemMs ?? 0);
  console.log(
    `Resources: CPU ${cpuMs}ms, peak RSS ${diagnosis.resources.peakRssBytes ?? 0} bytes, ${diagnosis.resources.runtime}`,
  );
  printOptionalDiagnosis(diagnosis);
  if (timeline) printTimeline(timeline);
}

function printDurations(
  label: string,
  entries: Array<{ name: string; durationMs: number; status: string }>,
): void {
  console.log(`${label}:`);
  if (entries.length === 0) console.log("  none");
  for (const entry of entries) {
    console.log(`  ${entry.name} ${entry.durationMs}ms ${entry.status}`);
  }
}

function printOptionalDiagnosis(diagnosis: ReturnType<typeof diagnoseRunBundle>): void {
  if (diagnosis.timeToFirstTokenMs !== undefined) {
    console.log(`Time to first token: ${diagnosis.timeToFirstTokenMs}ms`);
  }
  if (diagnosis.missingEvidence.length > 0) {
    console.log(`Missing evidence: ${diagnosis.missingEvidence.join(", ")}`);
  }
}

function printTimeline(
  timeline: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>["spans"],
): void {
  console.log("Timeline:");
  const ordered = [...timeline].sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt),
  );
  for (const span of ordered) {
    console.log(`  ${span.startedAt} ${span.name} ${span.durationMs ?? 0}ms ${span.status}`);
  }
}
