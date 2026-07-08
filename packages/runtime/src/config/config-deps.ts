import path from "node:path";

const runtimeProvidedPackages = new Set(["@usepipr/sdk", "@types/bun"]);

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

type InstallableDependency = {
  name: string;
  spec: string;
};

export async function installConfigDependencies(
  configDir: string,
  options: { frozen?: boolean } = {},
): Promise<void> {
  const packageJsonPath = path.join(configDir, "package.json");
  if (!(await fileExists(packageJsonPath))) {
    return;
  }
  const manifest = JSON.parse(await Bun.file(packageJsonPath).text()) as PackageManifest;
  const installablePackages = installableDependencySpecs(manifest);
  if (installablePackages.length === 0) {
    return;
  }
  const bunLockPath = path.join(configDir, "bun.lock");
  if (options.frozen && !(await fileExists(bunLockPath))) {
    throw new Error(
      `${configDir}: bun.lock is required when .pipr/package.json declares dependencies. ` +
        "Run `bun install` in .pipr/ and commit bun.lock.",
    );
  }
  await assertBunAvailable();
  const args = ["install", "--ignore-scripts", "--no-save"];
  if (options.frozen) {
    args.push("--frozen-lockfile");
  }
  if (installablePackages.every((dependency) => dependency.name === "typescript")) {
    // Bun verifies the runtime-owned SDK tarball even though Pipr replaces it with a stub.
    // Keep normal integrity checks for third-party config dependencies.
    args.push("--no-verify");
  }
  args.push(...installablePackages.map((dependency) => dependency.spec));
  const proc = Bun.spawn(["bun", ...args], {
    cwd: configDir,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
  if (exitCode !== 0) {
    throw new Error(
      `${configDir}: bun install failed (exit ${exitCode}).` +
        (stderr.trim().length > 0 ? `\n${stderr.trim()}` : ""),
    );
  }
}

function installableDependencySpecs(manifest: PackageManifest): InstallableDependency[] {
  return Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  })
    .filter(([name]) => !runtimeProvidedPackages.has(name))
    .map(([name, version]) => ({ name, spec: `${name}@${version}` }));
}

export async function assertBunAvailable(): Promise<void> {
  try {
    const proc = Bun.spawn(["bun", "--version"], {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(
        "bun is required on PATH to install .pipr/package.json dependencies. Install Bun from https://bun.sh",
      );
    }
  } catch {
    throw new Error(
      "bun is required on PATH to install .pipr/package.json dependencies. Install Bun from https://bun.sh",
    );
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}
