import { createHash } from "node:crypto";
import { chmod, mkdtemp, open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ReleasePlatform } from "./release/targets.js";
import { releaseAssetForPlatform } from "./release/targets.js";

export { releaseAssetForPlatform } from "./release/targets.js";

export type UpdateResult =
  | { kind: "up-to-date"; version: string }
  | { kind: "updated"; previousVersion: string; version: string };

export type UpdateNotice = {
  currentVersion: string;
  latestVersion: string;
};

type ReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>;

type UpdateOptions = {
  currentVersion: string;
  executablePath: string;
  fetch?: ReleaseFetch;
  platform?: ReleasePlatform;
};

type UpdateNoticeOptions = {
  currentVersion: string;
  fetch?: ReleaseFetch;
  timeoutMs?: number;
};

type LatestRelease = {
  tag_name?: unknown;
};

const officialRepo = "somus/pipr";
const packageManagerUpdateHelp = [
  "pipr update only supports compiled GitHub Release binaries.",
  "If you installed with npm, run: npm install -g @usepipr/cli@latest",
  "If you installed with Bun, run: bun install -g @usepipr/cli@latest",
  "If you installed from source, pull the repository and rebuild the CLI.",
].join("\n");

export function resolveCurrentExecutablePath(
  options: { argv?: string[]; execPath?: string } = {},
): string {
  const execPath = options.execPath ?? process.execPath;
  const argv = options.argv ?? process.argv;
  const execName = path.basename(execPath).toLowerCase();
  const scriptPath = argv[1];
  if (
    execName === "bun" ||
    execName.startsWith("bun-") ||
    execName === "node" ||
    execName.startsWith("node-") ||
    scriptPath?.endsWith(".ts") ||
    scriptPath?.endsWith(".mjs")
  ) {
    throw new Error(packageManagerUpdateHelp);
  }
  return execPath;
}

export async function runPiprUpdate(options: UpdateOptions): Promise<UpdateResult> {
  if (!isStableSemver(options.currentVersion)) {
    throw new Error(
      `current pipr version is not a stable semver version: ${options.currentVersion}`,
    );
  }
  const fetchRelease = options.fetch ?? globalThis.fetch.bind(globalThis);
  const platform = options.platform ?? { platform: process.platform, arch: process.arch };
  const asset = releaseAssetForPlatform(platform);
  const release = await latestRelease(fetchRelease);
  const version = release.version;
  if (compareSemver(version, options.currentVersion) <= 0) {
    return { kind: "up-to-date", version: options.currentVersion };
  }
  const [binary, checksums] = await Promise.all([
    downloadBytes(fetchRelease, releaseDownloadUrl(release.tag, asset)),
    downloadText(fetchRelease, releaseDownloadUrl(release.tag, "SHA256SUMS")),
  ]);
  verifyChecksum(binary, expectedChecksum(checksums, asset), asset);

  const tempPath = path.join(
    path.dirname(options.executablePath),
    `.pipr-update-${process.pid}-${Date.now()}`,
  );
  let createdTemp = false;
  let replaced = false;
  try {
    const tempFile = await open(tempPath, "wx", 0o700);
    createdTemp = true;
    try {
      await tempFile.writeFile(binary);
    } finally {
      await tempFile.close();
    }
    await chmod(tempPath, 0o755);
    const binaryVersion = await downloadedVersion(tempPath);
    if (!isStableSemver(binaryVersion)) {
      throw new Error(`downloaded pipr binary reported invalid version: ${binaryVersion}`);
    }
    if (binaryVersion !== version) {
      throw new Error(
        `downloaded pipr binary reported ${binaryVersion}, expected latest ${version}`,
      );
    }
    await rename(tempPath, options.executablePath);
    replaced = true;
    return { kind: "updated", previousVersion: options.currentVersion, version };
  } finally {
    if (createdTemp && !replaced) {
      await rm(tempPath, { force: true });
    }
  }
}

export async function availablePiprUpdateNotice(
  options: UpdateNoticeOptions,
): Promise<UpdateNotice | undefined> {
  if (!isStableSemver(options.currentVersion)) {
    return undefined;
  }
  const fetchRelease = withFetchTimeout(
    options.fetch ?? globalThis.fetch.bind(globalThis),
    options.timeoutMs,
  );
  const release = await latestRelease(fetchRelease);
  if (compareSemver(release.version, options.currentVersion) <= 0) {
    return undefined;
  }
  return { currentVersion: options.currentVersion, latestVersion: release.version };
}

function withFetchTimeout(fetchRelease: ReleaseFetch, timeoutMs: number | undefined): ReleaseFetch {
  if (timeoutMs === undefined) {
    return fetchRelease;
  }
  return async (url, init) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchRelease(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  };
}

async function latestRelease(fetchRelease: ReleaseFetch): Promise<{
  tag: string;
  version: string;
}> {
  const response = await fetchRelease(
    `https://api.github.com/repos/${officialRepo}/releases/latest`,
  );
  if (!response.ok) {
    throw new Error(`failed to fetch latest release metadata: HTTP ${response.status}`);
  }
  const release = (await response.json()) as LatestRelease;
  if (typeof release.tag_name !== "string") {
    throw new Error("latest release metadata is missing tag_name");
  }
  const version = release.tag_name.replace(/^v/, "");
  if (!isStableSemver(version)) {
    throw new Error(`latest release tag is not a stable semver version: ${release.tag_name}`);
  }
  return { tag: release.tag_name, version };
}

function releaseDownloadUrl(tag: string, asset: string): string {
  return `https://github.com/${officialRepo}/releases/download/${tag}/${asset}`;
}

async function downloadBytes(
  fetchRelease: (url: string) => Promise<Response>,
  url: string,
): Promise<Buffer> {
  const response = await fetchRelease(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

async function downloadText(
  fetchRelease: (url: string) => Promise<Response>,
  url: string,
): Promise<string> {
  const response = await fetchRelease(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  return await response.text();
}

function expectedChecksum(checksums: string, asset: string): string {
  for (const line of checksums.split(/\r?\n/)) {
    const [checksum, name] = line.trim().split(/\s+/);
    if (name === asset && checksum) {
      return checksum;
    }
  }
  throw new Error(`checksum for ${asset} not found`);
}

function verifyChecksum(binary: Buffer, expected: string, asset: string): void {
  const actual = createHash("sha256").update(binary).digest("hex");
  if (actual !== expected) {
    throw new Error(`checksum mismatch for ${asset}`);
  }
}

async function downloadedVersion(executablePath: string): Promise<string> {
  const validationCwd = await mkdtemp(path.join(os.tmpdir(), "pipr-update-version-"));
  try {
    const process = Bun.spawn([executablePath, "--version"], {
      cwd: validationCwd,
      env: {
        HOME: validationCwd,
        PATH: "/usr/bin:/bin",
        TMPDIR: validationCwd,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      process.stdout ? new Response(process.stdout).text() : "",
      process.stderr ? new Response(process.stderr).text() : "",
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `downloaded pipr binary failed --version: ${stderr.trim() || stdout.trim() || exitCode}`,
      );
    }
    return stdout.trim();
  } finally {
    await rm(validationCwd, { force: true, recursive: true });
  }
}

function isStableSemver(version: string): boolean {
  return /^\d+\.\d+\.\d+$/.test(version);
}

function compareSemver(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}
