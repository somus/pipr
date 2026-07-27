import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  copyRunBundleInput,
  copyValidatedRunBundle,
  type DownloadedBundle,
  diagnoseRunBundle,
  FileSystemRunArchiveSource,
  GitHubRunArchiveSource,
  generateRunBundleIdentity,
  openRunBundlePackage,
  type RunArchiveSource,
  type RunQuery,
  type RunRecord,
} from "@usepipr/runtime";

export type RunSelector = {
  host: "github" | "gitlab" | "azure-devops" | "bitbucket" | "gitea" | "forgejo" | "codeberg";
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
  identity?: string[];
};

export type RunsDownloadOptions = {
  host?: string;
  repository?: string;
  output?: string;
  archive?: boolean;
  store?: string;
  identity?: string[];
};

export type RunsInspectOptions = {
  timeline?: boolean;
  identity?: string[];
  json?: boolean;
};

export type RunsKeygenOptions = {
  output?: string;
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
  await renderSelectedRun(selected, resolvedExecutionId, options, context);
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
  throw new Error(
    withLookupErrors("No completed Pipr run matched the PR selector", collected.errors),
  );
}

async function selectRunByExecutionId(
  executionId: string,
  sources: SourceEntry[],
): Promise<CollectedRecord> {
  const validId = validExecutionId(executionId);
  const collected = await collectExactRecord(sources, {
    executionId: validId,
    kind: "all",
    limit: 1000,
  });
  const selected = collected.records.find((record) => record.executionId === validId);
  if (selected) return selected;
  throw new Error(
    withLookupErrors(
      `Pipr run ${validId} was not found in local or GitHub storage`,
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
  return `Pipr run ${executionId} is ${selected.state} and cannot be downloaded`;
}

async function renderSelectedRun(
  selected: CollectedRecord,
  executionId: string,
  options: RunsShowOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runs-show-"));
  try {
    const downloaded = await selected.archiveSource.download(
      selected.ref,
      path.join(temporaryRoot, executionId),
    );
    await renderDownloadedRun(downloaded, options, context, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runRunsInspect(
  inputPath: string,
  options: RunsInspectOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const source = path.resolve(context.cwd, inputPath);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runs-inspect-"));
  try {
    const destination = path.join(temporaryRoot, "downloaded");
    const downloaded = await copyRunBundleInput(source, destination);
    await renderDownloadedRun(downloaded, options, context, temporaryRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function renderDownloadedRun(
  downloaded: DownloadedBundle,
  options: RunsInspectOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
  temporaryRoot: string,
): Promise<void> {
  const view = await openDownloadedRunForShow(downloaded, options, {
    ...context,
    temporaryRoot,
  });
  const bundle = view.bundle;
  const diagnosis = diagnoseRunBundle(bundle);
  if (options.json) return printRunJson(bundle, diagnosis, view.protection, view.diagnostic);
  printDiagnosis(bundle.manifest, diagnosis, options.timeline ? bundle.spans : undefined);
  if (view.diagnostic === "locked") {
    console.log("Diagnostics: locked; pass --identity <path> to decrypt diagnostic artifacts");
  } else if (view.diagnostic !== "available") {
    console.log(`Diagnostics: ${view.diagnostic}`);
  }
}

function printRunJson(
  bundle: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>,
  diagnosis: ReturnType<typeof diagnoseRunBundle>,
  protection: "plaintext" | "metadata" | "age",
  diagnostic: "available" | "locked" | "not-captured" | "encryption-failed" | "size-limit",
): void {
  console.log(
    JSON.stringify(
      {
        formatVersion: 1,
        protection,
        diagnostic,
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
  const collected = await collectExactRecord(await runSources(options.store, context, selector), {
    executionId,
    kind: "all",
    limit: 1000,
  });
  const selected = collected.records.find((record) => record.executionId === executionId);
  if (!selected) {
    throw new Error(
      withLookupErrors(
        `Pipr run ${executionId} was not found in local or GitHub storage`,
        collected.errors,
      ),
    );
  }
  if (selected.state !== "available") {
    throw new Error(unavailableRunMessage(selected, executionId));
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-runs-download-"));
  try {
    const downloaded = await selected.archiveSource.download(
      { ...selected.ref, preserveArchive: options.archive },
      path.join(temporaryRoot, executionId),
    );
    if (downloaded.envelope?.protection === "age") {
      const identities = await resolveIdentityContents(options.identity, context);
      if (identities.values.length === 0) {
        throw new Error(
          `Pipr run ${executionId} is encrypted; pass --identity <path> or set PIPR_RUN_AGE_IDENTITY`,
        );
      }
      if (!downloaded.packageDirectory) {
        throw new Error("Encrypted Run Bundle package is missing its ciphertext directory");
      }
      await openRunBundlePackage({
        packageDirectory: downloaded.packageDirectory,
        destination,
        identities: identities.values,
      });
    } else {
      await copyValidatedRunBundle(downloaded.directory, destination);
    }
    console.log(destination);
    if (downloaded.archivePath) {
      const archivePath = `${destination}${path.extname(downloaded.archivePath) || ".archive"}`;
      await copyFile(downloaded.archivePath, archivePath, fsConstants.COPYFILE_EXCL);
      await chmod(archivePath, 0o600);
      console.log(archivePath);
    }
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function runRunsKeygen(
  options: RunsKeygenOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<void> {
  const output = path.resolve(
    context.cwd,
    options.output ??
      path.join(await defaultPiprStateRoot(context.env), "keys", "run-observability.agekey"),
  );
  await ensurePrivateParent(path.dirname(output));
  const key = await generateRunBundleIdentity();
  await writeFile(output, `${key.identity}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await chmod(output, 0o600);
  console.log(`Identity: ${output}`);
  console.log(`Recipient: ${key.recipient}`);
}

async function openDownloadedRunForShow(
  downloaded: DownloadedBundle,
  options: RunsShowOptions,
  context: { env: NodeJS.ProcessEnv; cwd: string; temporaryRoot: string },
): Promise<{
  bundle: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>;
  protection: "plaintext" | "metadata" | "age";
  diagnostic: "available" | "locked" | "not-captured" | "encryption-failed" | "size-limit";
}> {
  const { loadValidatedRunBundle } = await import("@usepipr/runtime");
  if (!downloaded.envelope) {
    return {
      bundle: await loadValidatedRunBundle(downloaded.directory),
      protection: "plaintext",
      diagnostic: "available",
    };
  }
  if (downloaded.envelope.protection === "age" && downloaded.packageDirectory) {
    const identities = await resolveIdentityContents(options.identity, context);
    if (identities.values.length > 0) {
      try {
        const opened = await openRunBundlePackage({
          packageDirectory: downloaded.packageDirectory,
          destination: path.join(context.temporaryRoot, "diagnostic"),
          identities: identities.values,
        });
        return {
          bundle: opened.bundle,
          protection: "age",
          diagnostic: "available",
        };
      } catch (error) {
        if (identities.explicit) throw error;
      }
    }
    return {
      bundle: await loadValidatedRunBundle(downloaded.directory),
      protection: "age",
      diagnostic: "locked",
    };
  }
  return {
    bundle: await loadValidatedRunBundle(downloaded.directory),
    protection: "metadata",
    diagnostic: downloaded.envelope.diagnosticState,
  };
}

async function resolveIdentityContents(
  explicitPaths: string[] | undefined,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<{ values: string[]; explicit: boolean }> {
  const configured = explicitPaths?.length
    ? explicitPaths
    : context.env.PIPR_RUN_AGE_IDENTITY
      ? [context.env.PIPR_RUN_AGE_IDENTITY]
      : [];
  if (configured.length > 0) {
    return {
      values: await Promise.all(
        configured.map((identityPath) => readIdentity(identityPath, context.cwd)),
      ),
      explicit: true,
    };
  }
  const defaultPath = path.join(
    await defaultPiprStateRoot(context.env),
    "keys",
    "run-observability.agekey",
  );
  try {
    return { values: [await readIdentity(defaultPath, context.cwd)], explicit: false };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { values: [], explicit: false };
    }
    throw error;
  }
}

async function readIdentity(identityPath: string, cwd: string): Promise<string> {
  const resolved = path.resolve(cwd, identityPath);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Run Bundle identity must be a regular file: ${resolved}`);
  }
  const identity = (await readFile(resolved, "utf8")).trim();
  if (!identity) throw new Error(`Run Bundle identity is empty: ${resolved}`);
  return identity;
}

async function ensurePrivateParent(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireKeyDirectory(directory);
  if (created !== undefined) await chmod(directory, 0o700);
}

async function requireKeyDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Run Bundle key directory must be a real directory: ${directory}`);
  }
}

export async function resolveRunSelector(options: {
  pr: string;
  host?: string;
  repository?: string;
  cwd: string;
}): Promise<RunSelector> {
  const changeNumber = parseChangeNumber(options.pr);
  const urlSelector =
    changeNumber === undefined ? selectorFromUrl(options.pr, options.host) : undefined;
  let discovered: Omit<RunSelector, "changeNumber"> | undefined = urlSelector;
  if (!discovered && (!options.host || !options.repository)) {
    discovered = await selectorFromGitRemote(options.cwd);
  }
  const host = options.host ? parseHost(options.host) : discovered?.host;
  const repository = options.repository ?? discovered?.repository;
  const resolvedChangeNumber = changeNumber ?? urlSelector?.changeNumber;
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
  const stateRoot = await defaultPiprStateRoot(env);
  return path.join(stateRoot, "runs", partition);
}

async function defaultPiprStateRoot(env: NodeJS.ProcessEnv): Promise<string> {
  const home = env.HOME ?? resolvedHomeDirectory();
  const stateRoot = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "pipr")
    : process.platform === "darwin" && home
      ? path.join(home, "Library", "Application Support", "pipr")
      : home
        ? path.join(home, ".local", "state", "pipr")
        : path.join(os.tmpdir(), "pipr-state");
  return stateRoot;
}

function resolvedHomeDirectory(): string | undefined {
  try {
    return os.homedir() || undefined;
  } catch {
    return undefined;
  }
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
  if (selector?.host === "github") {
    sources.push({ name: "github", archiveSource: githubSource(selector.repository, context.env) });
  }
  return sources;
}

function githubSource(repository: string, env: NodeJS.ProcessEnv): RunArchiveSource {
  const token = env.PIPR_GITHUB_TOKEN ?? env.GITHUB_TOKEN;
  return new GitHubRunArchiveSource({
    repository,
    ...(token ? { token } : {}),
    ...(env.GITHUB_API_URL ? { apiBaseUrl: env.GITHUB_API_URL } : {}),
  });
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
        message:
          result.reason instanceof Error ? result.reason.message : "run source lookup failed",
      });
    }
    const records = result.status === "fulfilled" ? result.value.records : [];
    collectSourceRecords(source, records);
  }
  return {
    records: [...byExecutionId.values()]
      .sort((left, right) => (right.startedAt ?? "").localeCompare(left.startedAt ?? ""))
      .slice(0, query.limit ?? 20),
    errors,
  };
}

async function collectExactRecord(
  sources: SourceEntry[],
  query: RunQuery & { executionId: string },
): ReturnType<typeof collectRecords> {
  const localSources = sources.filter((source) => source.name === "filesystem");
  const local = await collectRecords(localSources, query);
  if (local.records.some((record) => isCompletedAvailableRun(record))) return local;
  return await collectRecords(sources, query);
}

function recordPreference(record: CollectedRecord): number {
  const availability = record.state === "available" ? 10 : record.state === "in-progress" ? 5 : 0;
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

function selectorFromUrl(value: string, explicitHost?: string): RunSelector | undefined {
  const url = parseUrl(value);
  if (!url) return undefined;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const parsers = [githubUrlSelector, gitlabUrlSelector, azureUrlSelector];
  return (
    parsers.map((parse) => parse(url, parts)).find((result) => result !== undefined) ??
    bitbucketUrlSelector(url, parts, explicitHost) ??
    giteaUrlSelector(url, parts, explicitHost)
  );
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
    `${parts[git - 2]}/${parts[git - 1]}/${parts[git + 1]}`,
    parts[pullRequest + 1],
  );
};

function bitbucketUrlSelector(
  url: URL,
  parts: string[],
  explicitHost?: string,
): RunSelector | undefined {
  const bitbucketPull = parts.lastIndexOf("pull-requests");
  if (bitbucketPull < 2) return undefined;
  if (url.hostname === "bitbucket.org") {
    return selector("bitbucket", parts.slice(0, bitbucketPull).join("/"), parts[bitbucketPull + 1]);
  }
  const projects = bitbucketPull - 4;
  const repositories = bitbucketPull - 2;
  if (
    explicitHost !== "bitbucket" ||
    parts[projects] !== "projects" ||
    parts[repositories] !== "repos"
  ) {
    return undefined;
  }
  return selector(
    "bitbucket",
    `${parts[projects + 1]}/${parts[repositories + 1]}`,
    parts[bitbucketPull + 1],
  );
}

function giteaUrlSelector(
  url: URL,
  parts: string[],
  explicitHost?: string,
): RunSelector | undefined {
  const pull = parts.indexOf("pulls");
  if (pull < 2) return undefined;
  const host = url.hostname === "codeberg.org" ? "codeberg" : explicitGiteaFamilyHost(explicitHost);
  if (!host) return undefined;
  return selector(host, parts.slice(0, pull).join("/"), parts[pull + 1]);
}

function explicitGiteaFamilyHost(
  explicitHost: string | undefined,
): "gitea" | "forgejo" | "codeberg" | undefined {
  return explicitHost === "gitea" || explicitHost === "forgejo" || explicitHost === "codeberg"
    ? explicitHost
    : undefined;
}

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
  return azureRemoteUrlSelector(repository);
}

function azureRemoteUrlSelector(repository: string): Omit<RunSelector, "changeNumber"> | undefined {
  const parts = repository.split("/");
  const git = parts.indexOf("_git");
  return git >= 2 && parts[git + 1]
    ? {
        host: "azure-devops",
        repository: `${parts[git - 2]}/${parts[git - 1]}/${parts[git + 1]}`,
      }
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
    value === "bitbucket" ||
    value === "gitea" ||
    value === "forgejo" ||
    value === "codeberg"
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
    "in-progress",
    "expired",
    "capture-failed",
    "upload-failed",
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

const runListColumnWidths = {
  executionId: 32,
  kind: 9,
  outcome: 12,
  state: 21,
  protection: 10,
  startedAt: 25,
} as const;

export function printRunList(runs: RunRecord[]): void {
  if (runs.length === 0) {
    console.log("No Pipr runs found.");
    return;
  }
  console.log(
    [
      formatRunListColumn("EXECUTION ID", runListColumnWidths.executionId),
      formatRunListColumn("KIND", runListColumnWidths.kind),
      formatRunListColumn("OUTCOME", runListColumnWidths.outcome),
      formatRunListColumn("STATE", runListColumnWidths.state),
      formatRunListColumn("PROTECTION", runListColumnWidths.protection),
      formatRunListColumn("STARTED", runListColumnWidths.startedAt),
      "LOCATION",
    ].join("  "),
  );
  for (const run of runs) {
    console.log(
      [
        formatRunListColumn(run.executionId, runListColumnWidths.executionId),
        formatRunListColumn(run.kind ?? "unknown", runListColumnWidths.kind),
        formatRunListColumn(run.outcome ?? "unknown", runListColumnWidths.outcome),
        formatRunListColumn(run.state, runListColumnWidths.state),
        formatRunListColumn(run.protection ?? "unknown", runListColumnWidths.protection),
        formatRunListColumn(run.startedAt ?? "unknown", runListColumnWidths.startedAt),
        run.nativeUrl ?? run.error ?? "-",
      ].join("  "),
    );
  }
}

function formatRunListColumn(value: string, width: number): string {
  return value.slice(0, width).padEnd(width);
}

function printDiagnosis(
  manifest: Awaited<
    ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>
  >["manifest"],
  diagnosis: ReturnType<typeof diagnoseRunBundle>,
  timeline?: Awaited<ReturnType<typeof import("@usepipr/runtime").loadValidatedRunBundle>>["spans"],
): void {
  printRunOverview(manifest, diagnosis);
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
  printModelAttempts(diagnosis);
  printFailures(diagnosis);
  if (timeline) printTimeline(timeline);
}

function printRunOverview(
  manifest: Parameters<typeof printDiagnosis>[0],
  diagnosis: Parameters<typeof printDiagnosis>[1],
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
  if (diagnosis.agentRunBudget) {
    console.log(
      `Agent runs: ${diagnosis.agentRunBudget.used}${diagnosis.agentRunBudget.limit === undefined ? "" : `/${diagnosis.agentRunBudget.limit}`}`,
    );
  }
  if (diagnosis.structuralAnalysis) {
    const structural = diagnosis.structuralAnalysis;
    console.log(
      `Structural analysis: ${structural.status}, ${structural.durationMs}ms, ${structural.fileCount} files, ${structural.declarationCount} declarations${structural.reason ? `, ${structural.reason}` : ""}`,
    );
  }
}

function printFailures(diagnosis: ReturnType<typeof diagnoseRunBundle>): void {
  if (diagnosis.failures.length > 0) {
    console.log("Failures:");
    for (const failure of diagnosis.failures) {
      console.log(
        `  ${failure.event}${failure.task ? ` (${failure.task})` : ""}: ${failure.message}`,
      );
    }
  }
}

function printModelAttempts(diagnosis: ReturnType<typeof diagnoseRunBundle>): void {
  console.log("Model attempts:");
  if (diagnosis.modelAttempts.length === 0) console.log("  none");
  for (const attempt of diagnosis.modelAttempts) {
    const shard =
      attempt.shardIndex === undefined
        ? ""
        : ` shard ${attempt.shardIndex}/${attempt.shardCount ?? "?"}`;
    console.log(
      `  ${attempt.agent}${attempt.task ? ` (${attempt.task})` : ""}${shard} ${attempt.provider}/${attempt.model} ${attempt.attemptType}#${attempt.attemptNumber}${attempt.authMode ? ` ${attempt.authMode}` : ""} ${attempt.durationMs}ms ${attempt.status}`,
    );
  }
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
