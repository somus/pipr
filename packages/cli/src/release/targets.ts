export type ReleasePlatform = {
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
};

export type ReleaseTarget = ReleasePlatform & {
  target: string;
  outfile: string;
};

export const releaseTargets: ReleaseTarget[] = [
  { platform: "linux", arch: "x64", target: "bun-linux-x64-baseline", outfile: "pipr-linux-x64" },
  { platform: "linux", arch: "arm64", target: "bun-linux-arm64", outfile: "pipr-linux-arm64" },
  { platform: "darwin", arch: "x64", target: "bun-darwin-x64", outfile: "pipr-darwin-x64" },
  {
    platform: "darwin",
    arch: "arm64",
    target: "bun-darwin-arm64",
    outfile: "pipr-darwin-arm64",
  },
];

export function releaseTargetForPlatform(platform: ReleasePlatform): ReleaseTarget | undefined {
  return releaseTargets.find(
    (target) => target.platform === platform.platform && target.arch === platform.arch,
  );
}

export function releaseAssetForPlatform(platform: ReleasePlatform): string {
  const target = releaseTargetForPlatform(platform);
  if (target) {
    return target.outfile;
  }
  if (!releaseTargets.some((item) => item.platform === platform.platform)) {
    throw new Error(`pipr update unsupported OS: ${platform.platform}`);
  }
  throw new Error(`pipr update unsupported architecture: ${platform.arch}`);
}
