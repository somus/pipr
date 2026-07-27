const maxWorkflowUrlLength = 2_048;

export function workflowUrlFromEnvironment(
  host: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const candidate = workflowUrlCandidate(host, env);
  if (!candidate || candidate.length > maxWorkflowUrlLength) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function workflowUrlCandidate(host: string, env: NodeJS.ProcessEnv): string | undefined {
  switch (host) {
    case "github":
      return joinedUrl(
        env.GITHUB_SERVER_URL,
        env.GITHUB_REPOSITORY,
        "actions",
        "runs",
        env.GITHUB_RUN_ID,
      );
    case "gitlab":
      return env.CI_PIPELINE_URL;
    case "azure-devops":
      return joinedUrl(
        env.SYSTEM_TEAMFOUNDATIONCOLLECTIONURI,
        env.SYSTEM_TEAMPROJECT,
        "_build",
        env.BUILD_BUILDID ? `results?buildId=${encodeURIComponent(env.BUILD_BUILDID)}` : undefined,
      );
    case "bitbucket":
      return joinedUrl(
        env.BITBUCKET_GIT_HTTP_ORIGIN?.replace(/\.git\/?$/, ""),
        "pipelines",
        "results",
        env.BITBUCKET_BUILD_NUMBER,
      );
    default:
      return undefined;
  }
}

function joinedUrl(
  base: string | undefined,
  ...parts: Array<string | undefined>
): string | undefined {
  if (!base || parts.some((part) => !part)) {
    return undefined;
  }
  const path = parts.map((part) => encodePathPart(part ?? "")).join("/");
  return `${base.replace(/\/+$/, "")}/${path}`;
}

function encodePathPart(value: string): string {
  if (value.startsWith("results?buildId=")) {
    return value;
  }
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}
