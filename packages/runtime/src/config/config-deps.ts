import path from "node:path";
import { normalizePackageManifest, type PackageManifest } from "./package-manifest.js";

const runtimeProvidedPackages = new Set(["@usepipr/sdk", "@types/bun"]);

export async function installConfigDependencies(configDir: string): Promise<void> {
  const packageJsonPath = path.join(configDir, "package.json");
  if (!(await Bun.file(packageJsonPath).exists())) {
    return;
  }
  const originalPackageJson = await Bun.file(packageJsonPath).text();
  const manifest = normalizePackageManifest(JSON.parse(originalPackageJson));
  if (!hasInstallableDependencies(manifest)) {
    return;
  }
  const bunLockPath = path.join(configDir, "bun.lock");
  const originalBunLock = (await Bun.file(bunLockPath).exists())
    ? await Bun.file(bunLockPath).text()
    : undefined;
  if (originalBunLock === undefined) {
    throw new Error(
      `${configDir}: bun.lock is required when .pipr/package.json declares dependencies. ` +
        "Run `bun install` in .pipr/ and commit bun.lock.",
    );
  }
  await assertBunAvailable();
  await withSanitizedConfigInstallInputs(
    { packageJsonPath, originalPackageJson, bunLockPath, originalBunLock },
    async () => {
      if (hasRuntimeProvidedDependencies(manifest)) {
        await runConfigBunInstall(configDir, ["install", "--ignore-scripts", "--lockfile-only"]);
        const projectedBunLock = await Bun.file(bunLockPath).text();
        assertTrustedLockProjection(configDir, originalBunLock, projectedBunLock);
      }
      await runConfigBunInstall(configDir, [
        "install",
        "--ignore-scripts",
        "--no-save",
        "--frozen-lockfile",
      ]);
    },
  );
}

async function withSanitizedConfigInstallInputs(
  inputs: {
    packageJsonPath: string;
    originalPackageJson: string;
    bunLockPath: string;
    originalBunLock: string;
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
    await install();
  } finally {
    if (wroteInstallInputs) {
      await Bun.write(inputs.packageJsonPath, inputs.originalPackageJson);
      await Bun.write(inputs.bunLockPath, inputs.originalBunLock);
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

function hasInstallableDependencies(manifest: PackageManifest): boolean {
  return dependencyEntries(manifest).some(([name]) => !runtimeProvidedPackages.has(name));
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

function assertTrustedLockProjection(
  configDir: string,
  committedLockfile: string,
  projectedLockfile: string,
): void {
  let committed: unknown;
  let projected: unknown;
  try {
    committed = Bun.JSONC.parse(committedLockfile);
    projected = Bun.JSONC.parse(projectedLockfile);
  } catch {
    throw new Error(`${configDir}: projected bun.lock is not valid JSONC.`);
  }
  if (!isRecord(committed) || !isRecord(projected)) {
    throw new Error(`${configDir}: projected bun.lock must be an object.`);
  }
  const { packages: committedPackages, ...committedMetadata } = committed;
  const { packages: projectedPackages, ...projectedMetadata } = projected;
  const expectedMetadata = metadataWithoutRuntimeProvidedDependencies(committedMetadata);
  const changedPath =
    firstProjectionChange(expectedMetadata, projectedMetadata) ??
    firstProjectionChange(projectedMetadata, expectedMetadata);
  if (changedPath !== undefined) {
    throw new Error(
      `${configDir}: projected bun.lock changed committed dependency data at ${changedPath}.`,
    );
  }
  assertProjectedPackages(configDir, committedPackages, projectedPackages);
}

function metadataWithoutRuntimeProvidedDependencies(
  committedMetadata: Record<string, unknown>,
): Record<string, unknown> {
  const expectedMetadata = structuredClone(committedMetadata);
  const workspaces = expectedMetadata.workspaces;
  const rootWorkspace = isRecord(workspaces) ? workspaces[""] : undefined;
  if (!isRecord(rootWorkspace)) {
    return expectedMetadata;
  }
  for (const key of ["dependencies", "devDependencies"] as const) {
    const dependencies = rootWorkspace[key];
    if (!isRecord(dependencies)) {
      continue;
    }
    for (const name of runtimeProvidedPackages) {
      delete dependencies[name];
    }
    if (Object.keys(dependencies).length === 0) {
      delete rootWorkspace[key];
    }
  }
  return expectedMetadata;
}

function assertProjectedPackages(
  configDir: string,
  committedPackages: unknown,
  projectedPackages: unknown,
): void {
  if (!isRecord(committedPackages) || !isRecord(projectedPackages)) {
    throw new Error(`${configDir}: projected bun.lock packages must be objects.`);
  }
  const committedValues = Object.values(committedPackages);
  for (const [key, projectedValue] of Object.entries(projectedPackages)) {
    const committedValue = committedPackages[key];
    const matchesCommitted =
      committedValue === undefined
        ? committedValues.some((value) => isDeepEqual(value, projectedValue))
        : isDeepEqual(committedValue, projectedValue);
    if (!matchesCommitted) {
      throw new Error(
        `${configDir}: projected bun.lock changed committed dependency data at bun.lock.packages.${key}.`,
      );
    }
  }
}

function isDeepEqual(left: unknown, right: unknown): boolean {
  return (
    firstProjectionChange(left, right) === undefined &&
    firstProjectionChange(right, left) === undefined
  );
}

function firstProjectionChange(
  committed: unknown,
  projected: unknown,
  valuePath = "bun.lock",
): string | undefined {
  if (Array.isArray(committed)) {
    return firstArrayProjectionChange(committed, projected, valuePath);
  }
  if (isRecord(committed)) {
    return firstRecordProjectionChange(committed, projected, valuePath);
  }
  return Object.is(committed, projected) ? undefined : valuePath;
}

function firstArrayProjectionChange(
  committed: unknown[],
  projected: unknown,
  valuePath: string,
): string | undefined {
  if (!Array.isArray(projected) || committed.length !== projected.length) {
    return valuePath;
  }
  for (const [index, value] of projected.entries()) {
    const changedPath = firstProjectionChange(committed[index], value, `${valuePath}[${index}]`);
    if (changedPath !== undefined) {
      return changedPath;
    }
  }
  return undefined;
}

function firstRecordProjectionChange(
  committed: Record<string, unknown>,
  projected: unknown,
  valuePath: string,
): string | undefined {
  if (!isRecord(projected)) {
    return valuePath;
  }
  for (const [key, value] of Object.entries(projected)) {
    const childPath = `${valuePath}.${key}`;
    if (!Object.hasOwn(committed, key)) {
      return childPath;
    }
    const changedPath = firstProjectionChange(committed[key], value, childPath);
    if (changedPath !== undefined) {
      return changedPath;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
