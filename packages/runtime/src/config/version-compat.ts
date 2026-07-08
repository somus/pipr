import path from "node:path";
import { compareStableSemver, isStableSemver } from "../shared/semver.js";
import { runtimeVersion } from "../shared/version.js";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

export type ConfigVersionCompatibility =
  | {
      kind: "unknown";
      runtimeVersion: string;
      configVersion?: never;
      warning?: never;
    }
  | {
      kind: "matched";
      runtimeVersion: string;
      configVersion: string;
      warning?: never;
    }
  | {
      kind: "runtime-newer";
      runtimeVersion: string;
      configVersion: string;
      warning: string;
    }
  | {
      kind: "uncomparable";
      runtimeVersion: string;
      configVersion?: never;
      warning: string;
    };

export async function resolveConfigVersionCompatibility(options: {
  configDirPath: string;
  configDir: string;
}): Promise<ConfigVersionCompatibility> {
  const packageJsonPath = path.join(options.configDirPath, "package.json");
  if (!(await Bun.file(packageJsonPath).exists())) {
    return { kind: "unknown", runtimeVersion };
  }

  const manifest = (await Bun.file(packageJsonPath).json()) as PackageManifest;
  const sdkVersion =
    manifest.dependencies?.["@usepipr/sdk"] ?? manifest.devDependencies?.["@usepipr/sdk"];
  if (!sdkVersion) {
    return { kind: "unknown", runtimeVersion };
  }

  const packageJsonLabel =
    options.configDir === "." ? "package.json" : `${options.configDir}/package.json`;
  const bunLockLabel = options.configDir === "." ? "bun.lock" : `${options.configDir}/bun.lock`;
  if (!isStableSemver(sdkVersion)) {
    return {
      kind: "uncomparable",
      runtimeVersion,
      warning: `${packageJsonLabel} declares @usepipr/sdk as ${JSON.stringify(sdkVersion)}; use an exact version to enable Pipr config version checks.`,
    };
  }
  if (!isStableSemver(runtimeVersion)) {
    return {
      kind: "uncomparable",
      runtimeVersion,
      warning: `This Pipr runtime reports version ${runtimeVersion}; skipping Pipr config version checks.`,
    };
  }

  const comparison = compareStableSemver(runtimeVersion, sdkVersion);
  if (comparison === 0) {
    return { kind: "matched", runtimeVersion, configVersion: sdkVersion };
  }
  if (comparison > 0) {
    return {
      kind: "runtime-newer",
      runtimeVersion,
      configVersion: sdkVersion,
      warning: `${packageJsonLabel} pins @usepipr/sdk ${sdkVersion}, but this Pipr runtime is ${runtimeVersion}. Run \`pipr init --force\` or update ${packageJsonLabel} and ${bunLockLabel} when ready.`,
    };
  }

  throw new Error(
    `${packageJsonLabel} pins @usepipr/sdk ${sdkVersion}, but this Pipr runtime is ${runtimeVersion}. Upgrade Pipr before running this config.`,
  );
}
