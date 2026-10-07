import path from "node:path";

/** CI checkout directories, checked in order when no workspace root is passed. */
const workspaceVariables = [
  "GITEA_WORKSPACE",
  "FORGEJO_WORKSPACE",
  "GITHUB_WORKSPACE",
  "CI_PROJECT_DIR",
  "BITBUCKET_CLONE_DIR",
  "BUILD_SOURCESDIRECTORY",
] as const;

/** Native event payload paths, checked in order when no event path is passed. */
const eventPathVariables = [
  "PIPR_EVENT_PATH",
  "GITEA_EVENT_PATH",
  "FORGEJO_EVENT_PATH",
  "GITHUB_EVENT_PATH",
] as const;

/** Resolves the host run workspace root and event payload path from CI env when not passed. */
export function resolveHostRunLocation(options: {
  rootDir?: string;
  eventPath?: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
}): { rootDir: string; eventPath?: string } {
  const cwd = options.cwd ?? process.cwd();
  const rootDir = options.rootDir ?? firstSet(options.env, workspaceVariables) ?? cwd;
  const eventPath = options.eventPath ?? firstSet(options.env, eventPathVariables);
  return {
    rootDir,
    ...(eventPath === undefined ? {} : { eventPath: path.resolve(cwd, eventPath) }),
  };
}

function firstSet(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) return value;
  }
  return undefined;
}
