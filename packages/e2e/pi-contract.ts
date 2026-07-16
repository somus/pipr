import {
  piBuiltinToolNames,
  piReadOnlyToolNames,
  piRequiredCliFlags,
  piThinkingLevels,
} from "@usepipr/runtime/internal/testing";

type CheckOptions = {
  cwd: string;
  image?: string;
  piExecutable?: string;
};

export async function checkPiContract(options: CheckOptions): Promise<void> {
  const help = runPi(options, ["--help"]);
  const version = runPi(options, ["--version"]).trim();
  const dockerfileVersion = await readDockerfilePiVersion(options.cwd);

  if (version !== dockerfileVersion) {
    throw new Error(
      `Dockerfile Pi package version must match pi --version: expected '${dockerfileVersion}', got '${version}'`,
    );
  }
  assertContainsAll(help, piRequiredCliFlags, "Pi CLI flag");
  assertContainsAll(help, piThinkingLevels, "Pi thinking level");
  assertContainsAll(help, piBuiltinToolNames, "Pi built-in tool");
  assertSubset(
    piReadOnlyToolNames,
    piBuiltinToolNames,
    "pipr read-only tools must be Pi built-ins",
  );

  console.log(
    `Pi contract ok: pi ${version}; thinking=${piThinkingLevels.join(",")}; ` +
      `readOnlyTools=${piReadOnlyToolNames.join(",")}`,
  );
}

function runPi(options: CheckOptions, args: string[]): string {
  return runCommand(piCommand(options, args), options.cwd);
}

function piCommand(options: CheckOptions, args: string[]): string[] {
  if (options.image) {
    return ["docker", "run", "--rm", "--entrypoint", "pi", options.image, ...args];
  }
  return [options.piExecutable ?? "pi", ...args];
}

function runCommand(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed with ${result.exitCode}: ${
        result.stderr.toString() || result.stdout.toString()
      }`,
    );
  }
  return result.stdout.toString();
}

const piPackageNames = ["pi-coding-agent", "pi-ai", "pi-tui", "pi-agent-core"] as const;

export async function readDockerfilePiVersion(cwd: string): Promise<string> {
  const dockerfile = await Bun.file(`${cwd}/Dockerfile`).text();
  const versions = piPackageNames.map((packageName) => {
    const match = dockerfile.match(new RegExp(`@earendil-works/${packageName}@([^\\s\\\\]+)`));
    if (!match?.[1]) {
      throw new Error(`Dockerfile does not pin @earendil-works/${packageName}`);
    }
    return match[1];
  });
  if (new Set(versions).size !== 1) {
    throw new Error(`Dockerfile Pi package versions must match: ${versions.join(", ")}`);
  }
  return versions[0];
}

function assertContainsAll(haystack: string, needles: readonly string[], label: string): void {
  const missing = needles.filter((needle) => !haystack.includes(needle));
  if (missing.length > 0) {
    throw new Error(`${label} missing from pi --help: ${missing.join(", ")}`);
  }
}

function assertSubset<T extends string>(
  subset: readonly T[],
  superset: readonly string[],
  label: string,
): void {
  const missing = subset.filter((value) => !superset.includes(value));
  if (missing.length > 0) {
    throw new Error(`${label}: ${missing.join(", ")}`);
  }
}
