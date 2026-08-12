import type { RunQuery } from "@usepipr/runtime";
import type { RunSelector } from "./runs-types.js";

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

export async function resolveRepositorySelector(options: {
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

export async function selectorFromGitRemote(
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

export function parseKind(value: string | undefined, fallback: RunQuery["kind"]): RunQuery["kind"] {
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

export function parseStatus(value: string): NonNullable<RunQuery["status"]> {
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

export function parseLimit(value: string | undefined): number {
  const limit = Number(value ?? "20");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error("--limit must be an integer between 1 and 1000");
  }
  return limit;
}
