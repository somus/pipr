import { join } from "node:path";

/** Packages that make up the durable Pi harness; they release together and must share one exact version. */
const harnessPackageNames = [
  "@earendil-works/pi-durable",
  "@earendil-works/pi-ai",
  "@earendil-works/chord",
] as const;

/** Workspace packages that load the harness directly: the runtime, plus scripted model providers for fixtures. */
const harnessManifestPaths = [
  "packages/runtime/package.json",
  "packages/e2e/package.json",
  "packages/evals/package.json",
] as const;

type CheckOptions = {
  cwd: string;
  image?: string;
};

export async function checkHarnessContract(options: CheckOptions): Promise<void> {
  const version = await readHarnessVersion(options.cwd);
  const help = runPipr(options, ["agent-worker", "--help"]);
  if (!help.includes("Usage: pipr agent-worker")) {
    throw new Error(`pipr agent-worker --help printed unexpected usage:\n${help}`);
  }
  runPipr(options, ["host-run", "--help"]);
  console.log(`Harness contract ok: ${harnessPackageNames.join(", ")} ${version}; agent-worker ok`);
}

/**
 * Returns the shared harness version after checking that every workspace pin is exact, the harness packages agree,
 * and `bun.lock` resolves each package to that version.
 */
export async function readHarnessVersion(cwd: string): Promise<string> {
  const runtimeDependencies = await readDependencies(cwd, harnessManifestPaths[0]);
  const versions = harnessPackageNames.map((name) => {
    const version = runtimeDependencies[name];
    if (!version) {
      throw new Error(`packages/runtime/package.json does not depend on ${name}`);
    }
    return version;
  });
  const version = versions[0];
  if (!/^\d+\.\d+\.\d+$/.test(version) || new Set(versions).size !== 1) {
    throw new Error(
      `Harness packages must share one exact version: ${harnessPackageNames
        .map((name, index) => `${name}@${versions[index]}`)
        .join(", ")}`,
    );
  }
  for (const manifestPath of harnessManifestPaths.slice(1)) {
    const dependencies = await readDependencies(cwd, manifestPath);
    for (const name of harnessPackageNames) {
      if (dependencies[name] !== undefined && dependencies[name] !== version) {
        throw new Error(`${manifestPath} pins ${name}@${dependencies[name]}; expected ${version}`);
      }
    }
  }
  const lockfile = await Bun.file(join(cwd, "bun.lock")).text();
  for (const name of harnessPackageNames) {
    if (!lockfile.includes(`"${name}": ["${name}@${version}"`)) {
      throw new Error(`bun.lock does not resolve ${name}@${version}`);
    }
  }
  return version;
}

async function readDependencies(
  cwd: string,
  manifestPath: string,
): Promise<Record<string, string>> {
  const manifest = (await Bun.file(join(cwd, manifestPath)).json()) as {
    dependencies?: Record<string, string>;
  };
  return manifest.dependencies ?? {};
}

function runPipr(options: CheckOptions, args: string[]): string {
  const command = options.image
    ? ["docker", "run", "--rm", "--user", "1000:1000", options.image, ...args]
    : ["bun", "packages/cli/src/main.ts", ...args];
  const result = Bun.spawnSync(command, { cwd: options.cwd, stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with ${result.exitCode}: ${
        result.stderr.toString() || result.stdout.toString()
      }`,
    );
  }
  return result.stdout.toString();
}
