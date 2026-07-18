#!/usr/bin/env bun
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PackageManifest = {
  name: string;
  version: string;
  files?: string[];
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: Record<string, string>;
  engines?: { bun?: string };
};

type PackFile = {
  path: string;
  mode?: number;
};

type PackResult = {
  name: string;
  version: string;
  filename: string;
  files: PackFile[];
};

type VerifyPackedPackageOptions = {
  manifest: PackageManifest;
  files: PackFile[];
  rootLicense: string;
  packedLicense: string;
};

const requiredCliSkillFiles = [
  "dist/skills/pipr-setup/SKILL.md",
  "dist/skills/pipr-setup/references/config-patterns.md",
  "dist/skills/pipr-setup/references/recipes.md",
];
const allowedRootFiles = new Set(["LICENSE", "README.md", "package.json"]);
const privatePathPattern = /(^|\/)(?:__tests__|fixtures|src|test|tests)(?:\/|$)/;
const packageDirs = ["packages/sdk", "packages/runtime", "packages/cli"] as const;

export function verifyPackedPackage(options: VerifyPackedPackageOptions): void {
  const { manifest, files, rootLicense, packedLicense } = options;
  const paths = new Set(files.map((file) => file.path));

  assert.deepEqual(manifest.files, ["dist", "LICENSE"], `${manifest.name} files allowlist drifted`);
  for (const required of allowedRootFiles) {
    assert(paths.has(required), `${manifest.name} tarball is missing ${required}`);
  }
  assert.equal(
    packedLicense,
    rootLicense,
    `${manifest.name} LICENSE differs from the root license`,
  );

  for (const file of files) {
    assert(
      allowedRootFiles.has(file.path) || file.path.startsWith("dist/"),
      `${manifest.name} tarball contains unexpected path ${file.path}`,
    );
    assert(!privatePathPattern.test(file.path), `${manifest.name} tarball exposes ${file.path}`);
    assert(
      !file.path.split("/").some((segment) => segment.startsWith(".")),
      `${manifest.name} tarball exposes ${file.path}`,
    );
  }

  for (const entrypoint of manifestEntrypoints(manifest)) {
    assert(paths.has(entrypoint), `${manifest.name} tarball is missing entrypoint ${entrypoint}`);
  }

  if (manifest.name === "@usepipr/cli") {
    const cliBin = normalizePackagePath(manifest.bin?.pipr ?? "");
    const binFile = files.find((file) => file.path === cliBin);
    assert(binFile, `${manifest.name} tarball is missing its pipr executable`);
    assert.equal(binFile.mode, 0o755, `${manifest.name} pipr executable must use mode 0755`);
    for (const skillFile of requiredCliSkillFiles) {
      assert(paths.has(skillFile), `${manifest.name} tarball is missing ${skillFile}`);
    }
  }
}

function manifestEntrypoints(manifest: PackageManifest): Set<string> {
  const entrypoints = new Set<string>();
  collectPackagePath(manifest.main, entrypoints);
  collectPackagePath(manifest.types, entrypoints);
  for (const binPath of Object.values(manifest.bin ?? {})) collectPackagePath(binPath, entrypoints);
  collectExportPaths(manifest.exports, entrypoints);
  return entrypoints;
}

function collectExportPaths(value: unknown, paths: Set<string>): void {
  if (typeof value === "string") {
    collectPackagePath(value, paths);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const nested of Object.values(value)) collectExportPaths(nested, paths);
}

function collectPackagePath(value: string | undefined, paths: Set<string>): void {
  if (value?.startsWith("./")) paths.add(normalizePackagePath(value));
}

function normalizePackagePath(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}

async function main(): Promise<void> {
  const rootDir = path.resolve(import.meta.dirname, "..");
  const outputDir = path.join(rootDir, "dist", "npm");
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-npm-pack-"));
  const rootLicense = await Bun.file(path.join(rootDir, "LICENSE")).text();
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  try {
    for (const packageDir of packageDirs) {
      const absolutePackageDir = path.join(rootDir, packageDir);
      const result = packPackage(absolutePackageDir, outputDir, cacheDir);
      const tarballPath = path.join(outputDir, result.filename);
      const archivePaths = tarballPaths(tarballPath);
      const jsonPaths = result.files.map((file) => `package/${file.path}`).sort();
      assert.deepEqual(
        archivePaths,
        jsonPaths,
        `${result.name} archive differs from npm pack JSON`,
      );

      const packedManifest = JSON.parse(
        tarballText(tarballPath, "package/package.json"),
      ) as PackageManifest;
      assert.equal(result.name, packedManifest.name, `${packageDir} packed the wrong package name`);
      assert.equal(
        result.version,
        packedManifest.version,
        `${result.name} packed the wrong version`,
      );
      verifyPackedPackage({
        manifest: packedManifest,
        files: result.files,
        rootLicense,
        packedLicense: tarballText(tarballPath, "package/LICENSE"),
      });
      console.log(`verified ${result.filename} (${result.files.length} files)`);
    }
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

function packPackage(packageDir: string, outputDir: string, cacheDir: string): PackResult {
  const result = Bun.spawnSync(
    ["npm", "pack", "--json", "--silent", "--pack-destination", outputDir],
    {
      cwd: packageDir,
      env: { ...Bun.env, NPM_CONFIG_CACHE: cacheDir },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  assert.equal(result.exitCode, 0, result.stderr.toString() || "npm pack failed");
  const parsed = parsePackResults(result.stdout.toString());
  assert.equal(parsed.length, 1, `${packageDir} must produce exactly one tarball`);
  return parsed[0] as PackResult;
}

function parsePackResults(output: string): PackResult[] {
  for (
    let start = output.lastIndexOf("[");
    start >= 0;
    start = output.lastIndexOf("[", start - 1)
  ) {
    try {
      const value = JSON.parse(output.slice(start)) as unknown;
      if (Array.isArray(value)) return value as PackResult[];
    } catch {
      // Lifecycle scripts may write build logs before npm's final JSON array.
    }
  }
  throw new Error("npm pack did not emit a JSON result");
}

function tarballPaths(tarballPath: string): string[] {
  return runTar(["-tzf", tarballPath])
    .split("\n")
    .filter((entry) => entry && !entry.endsWith("/"))
    .sort();
}

function tarballText(tarballPath: string, archivePath: string): string {
  return runTar(["-xOf", tarballPath, archivePath]);
}

function runTar(args: string[]): string {
  const result = Bun.spawnSync(["tar", ...args], { stderr: "pipe", stdout: "pipe" });
  assert.equal(result.exitCode, 0, result.stderr.toString() || `tar ${args[0]} failed`);
  return result.stdout.toString();
}

if (import.meta.main) await main();
