/** The native CI run executing Pipr, as recorded in Run Bundles and linked from comments. */
export type CiRun = {
  runId?: string;
  jobId?: string;
  runUrl?: string;
  jobUrl?: string;
};

/** Matches the Run Bundle manifest URL limit. */
const maxRunUrlLength = 2_000;

/**
 * Derives the native CI run for `host` from its documented predefined variables. URLs are
 * encoded, validated as credential-free http(s), and dropped when incomplete; returns
 * `undefined` when nothing is known.
 */
export function ciRunFromEnvironment(host: string, env: NodeJS.ProcessEnv): CiRun | undefined {
  const run = Object.hasOwn(ciRunReaders, host) ? ciRunReaders[host]?.(env) : undefined;
  if (!run) return undefined;
  const compact = Object.fromEntries(
    Object.entries({
      runId: run.runId,
      jobId: run.jobId,
      runUrl: safeUrl(run.runUrl),
      jobUrl: safeUrl(run.jobUrl),
    }).filter(([, value]) => value),
  ) as CiRun;
  return Object.keys(compact).length > 0 ? compact : undefined;
}

/** Whether Pipr runs inside any supported native CI system. */
export function isNativeCiEnvironment(env: NodeJS.ProcessEnv): boolean {
  return (
    env.GITHUB_ACTIONS === "true" ||
    env.GITLAB_CI === "true" ||
    env.TF_BUILD === "True" ||
    env.TF_BUILD === "true" ||
    env.BITBUCKET_BUILD_NUMBER !== undefined ||
    env.GITEA_ACTIONS === "true" ||
    env.FORGEJO_ACTIONS === "true"
  );
}

const ciRunReaders: Record<string, (env: NodeJS.ProcessEnv) => CiRun> = {
  github: (env) => actionsRun(env, "GITHUB"),
  gitea: (env) => actionsRun(env, "GITHUB"),
  forgejo: (env) => actionsRun(env, "FORGEJO"),
  codeberg: (env) => actionsRun(env, "FORGEJO"),
  gitlab: (env) => ({
    runId: env.CI_PIPELINE_ID,
    jobId: env.CI_JOB_ID,
    runUrl: env.CI_PIPELINE_URL,
    jobUrl: env.CI_JOB_URL,
  }),
  "azure-devops": azurePipelinesRun,
  bitbucket: (env) => ({
    runId: env.BITBUCKET_PIPELINE_UUID ?? env.BITBUCKET_BUILD_NUMBER,
    jobId: env.BITBUCKET_STEP_UUID,
    runUrl: joinedUrl(
      env.BITBUCKET_GIT_HTTP_ORIGIN?.replace(/\.git\/?$/, ""),
      "pipelines",
      "results",
      env.BITBUCKET_BUILD_NUMBER,
    ),
  }),
};

/** `SYSTEM_COLLECTIONURI` is the documented collection variable; Pipr's Docker recipe forwards only it. */
function azurePipelinesRun(env: NodeJS.ProcessEnv): CiRun {
  const buildId = env.BUILD_BUILDID;
  const resultsUrl = joinedUrl(
    env.SYSTEM_COLLECTIONURI,
    env.SYSTEM_TEAMPROJECT,
    "_build",
    "results",
  );
  return {
    runId: buildId,
    jobId: env.SYSTEM_JOBID,
    runUrl:
      buildId && resultsUrl ? `${resultsUrl}?buildId=${encodeURIComponent(buildId)}` : undefined,
  };
}

/** GitHub, Gitea, and Forgejo Actions share one variable layout under different prefixes. */
function actionsRun(env: NodeJS.ProcessEnv, prefix: "GITHUB" | "FORGEJO"): CiRun {
  const runId = env[`${prefix}_RUN_ID`];
  return {
    runId,
    jobId: env[`${prefix}_JOB`],
    runUrl: joinedUrl(
      env[`${prefix}_SERVER_URL`],
      env[`${prefix}_REPOSITORY`],
      "actions",
      "runs",
      runId,
    ),
  };
}

function joinedUrl(
  base: string | undefined,
  ...parts: Array<string | undefined>
): string | undefined {
  if (!base || parts.some((part) => !part)) return undefined;
  const path = parts
    .flatMap((part) => (part ?? "").split("/"))
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base.replace(/\/+$/, "")}/${path}`;
}

function safeUrl(candidate: string | undefined): string | undefined {
  if (!candidate || candidate.length > maxRunUrlLength) return undefined;
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
