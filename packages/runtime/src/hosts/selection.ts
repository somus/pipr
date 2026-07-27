const codeHostIds = [
  "github",
  "gitlab",
  "azure-devops",
  "bitbucket",
  "gitea",
  "forgejo",
  "codeberg",
] as const;

export type CodeHostId = (typeof codeHostIds)[number];

export function resolveCodeHostId(options: {
  explicitHost?: string;
  env: NodeJS.ProcessEnv;
}): CodeHostId {
  const selected = options.explicitHost ?? options.env.PIPR_CODE_HOST;
  if (selected) {
    return parseCodeHostId(selected);
  }
  const detected: CodeHostId[] = [];
  const giteaFamily = detectedGiteaFamilyHost(options.env);
  if (giteaFamily) {
    detected.push(giteaFamily);
  } else if (options.env.GITHUB_ACTIONS !== undefined) {
    detected.push("github");
  }
  if (options.env.GITLAB_CI !== undefined) {
    detected.push("gitlab");
  }
  if (options.env.TF_BUILD !== undefined) {
    detected.push("azure-devops");
  }
  if (options.env.BITBUCKET_BUILD_NUMBER !== undefined) {
    detected.push("bitbucket");
  }
  if (detected.length === 1) {
    const host = detected[0];
    if (host) {
      return host;
    }
  }
  if (detected.length > 1) {
    throw new Error(`Multiple code hosts detected: ${detected.join(", ")}`);
  }
  throw new Error("A code host must be selected");
}

function parseCodeHostId(value: string): CodeHostId {
  switch (value) {
    case "github":
    case "gitlab":
    case "azure-devops":
    case "bitbucket":
    case "gitea":
    case "forgejo":
    case "codeberg":
      return value;
    default:
      throw new Error(
        `Unsupported code host '${value}'. Supported hosts: ${codeHostIds.join(", ")}`,
      );
  }
}

function detectedGiteaFamilyHost(env: NodeJS.ProcessEnv): CodeHostId | undefined {
  if (env.FORGEJO_ACTIONS !== undefined) {
    return isCodebergServer(env.FORGEJO_SERVER_URL) ? "codeberg" : "forgejo";
  }
  if (env.GITEA_ACTIONS !== undefined) {
    return "gitea";
  }
  return undefined;
}

function isCodebergServer(value: string | undefined): boolean {
  if (!value) return false;
  try {
    return new URL(value).hostname === "codeberg.org";
  } catch {
    return false;
  }
}
