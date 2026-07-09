import path from "node:path";
import { normalizePackageManifest, type PackageManifest } from "./package-manifest.js";
import { defaultScaffoldTypescriptSpec } from "./scaffold-versions.js";

const runtimeProvidedPackages = new Set(["@usepipr/sdk", "@types/bun"]);

type InstallableDependency = {
  name: string;
  spec: string;
};

export async function installConfigDependencies(
  configDir: string,
  options: { frozen?: boolean } = {},
): Promise<void> {
  const packageJsonPath = path.join(configDir, "package.json");
  if (!(await Bun.file(packageJsonPath).exists())) {
    return;
  }
  const originalPackageJson = await Bun.file(packageJsonPath).text();
  const manifest = normalizePackageManifest(JSON.parse(originalPackageJson));
  const installablePackages = installableDependencySpecs(manifest);
  if (installablePackages.length === 0) {
    return;
  }
  const bunLockPath = path.join(configDir, "bun.lock");
  const originalBunLock = (await Bun.file(bunLockPath).exists())
    ? await Bun.file(bunLockPath).text()
    : undefined;
  if (options.frozen && originalBunLock === undefined) {
    throw new Error(
      `${configDir}: bun.lock is required when .pipr/package.json declares dependencies. ` +
        "Run `bun install` in .pipr/ and commit bun.lock.",
    );
  }
  await assertBunAvailable();
  // Bun still treats the stripped runtime-provided entries as lockfile changes in temp copies.
  const args = configInstallArgs(installablePackages, {
    frozen: options.frozen === true && !hasRuntimeProvidedDependencies(manifest),
  });
  await withSanitizedConfigInstallInputs(
    { packageJsonPath, originalPackageJson, bunLockPath, originalBunLock },
    () => runConfigBunInstall(configDir, args),
  );
}

function configInstallArgs(
  installablePackages: InstallableDependency[],
  options: { frozen: boolean },
): string[] {
  return [
    "install",
    "--ignore-scripts",
    "--no-save",
    ...(options.frozen ? ["--frozen-lockfile"] : []),
    // Bun verifies the runtime-owned SDK tarball even though Pipr replaces it with a stub.
    // --no-verify skips every integrity check, so keep this only on the pinned scaffold install.
    ...(isDefaultScaffoldTypescriptInstall(installablePackages) ? ["--no-verify"] : []),
    ...installablePackages.map((dependency) => dependency.spec),
  ];
}

function isDefaultScaffoldTypescriptInstall(installablePackages: InstallableDependency[]): boolean {
  return (
    installablePackages.length === 1 &&
    installablePackages[0]?.spec === defaultScaffoldTypescriptSpec
  );
}

async function withSanitizedConfigInstallInputs(
  inputs: {
    packageJsonPath: string;
    originalPackageJson: string;
    bunLockPath: string;
    originalBunLock: string | undefined;
  },
  install: () => Promise<void>,
): Promise<void> {
  let wroteInstallInputs = false;
  try {
    await Bun.write(
      inputs.packageJsonPath,
      sanitizedPackageJsonForConfigInstall(inputs.originalPackageJson),
    );
    wroteInstallInputs = true;
    if (inputs.originalBunLock !== undefined) {
      await Bun.write(inputs.bunLockPath, sanitizedBunLockForConfigInstall(inputs.originalBunLock));
    }
    await install();
  } finally {
    if (wroteInstallInputs) {
      await Bun.write(inputs.packageJsonPath, inputs.originalPackageJson);
      if (inputs.originalBunLock !== undefined) {
        await Bun.write(inputs.bunLockPath, inputs.originalBunLock);
      }
    }
  }
}

async function runConfigBunInstall(configDir: string, args: string[]): Promise<void> {
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
  return dependencyEntries(manifest)
    .filter(([name]) => !runtimeProvidedPackages.has(name))
    .map(([name, version]) => ({ name, spec: `${name}@${version}` }));
}

function hasRuntimeProvidedDependencies(manifest: PackageManifest): boolean {
  return dependencyEntries(manifest).some(([name]) => runtimeProvidedPackages.has(name));
}

function dependencyEntries(manifest: PackageManifest): Array<[string, string]> {
  return Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  });
}

function sanitizedPackageJsonForConfigInstall(packageJson: string): string {
  const value = JSON.parse(packageJson) as Record<string, unknown>;
  for (const key of ["dependencies", "devDependencies"] as const) {
    const dependencies = value[key];
    if (dependencies === null || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    const sanitized = Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => !runtimeProvidedPackages.has(name)),
    );
    if (Object.keys(sanitized).length === 0) {
      delete value[key];
    } else {
      value[key] = sanitized;
    }
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sanitizedBunLockForConfigInstall(lockfile: string): string {
  let sanitized = lockfile;
  for (const packageName of runtimeProvidedPackages) {
    const escapedName = escapeRegExp(packageName);
    sanitized = sanitized.replace(
      new RegExp(`^\\s*"${escapedName}":\\s*"[^"]+",\\r?\\n`, "gm"),
      "",
    );
    sanitized = sanitized.replace(
      new RegExp(`^\\s*"${escapedName}":\\s*\\[[^\\n]*\\],\\r?\\n(?:\\r?\\n)?`, "gm"),
      "",
    );
  }
  return sanitized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
