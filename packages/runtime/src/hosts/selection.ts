const codeHostIds = ["github", "gitlab", "azure-devops", "bitbucket"] as const;

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
  if (options.env.GITHUB_ACTIONS !== undefined) {
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
      return value;
    default:
      throw new Error(
        `Unsupported code host '${value}'. Supported hosts: ${codeHostIds.join(", ")}`,
      );
  }
}
