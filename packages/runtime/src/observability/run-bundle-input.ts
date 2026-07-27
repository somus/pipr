import { lstat, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extractRunArchiveFiles } from "./archive-extraction.js";
import { copyValidatedRunBundle, type DownloadedBundle } from "./bundle-validation.js";
import { copyRunBundlePackage } from "./protected-package.js";
import { maximumRunBundleBytes } from "./types.js";

export async function copyRunBundleInput(
  sourcePath: string,
  destination: string,
): Promise<DownloadedBundle> {
  const source = path.resolve(sourcePath);
  const stats = await lstat(source);
  if (stats.isSymbolicLink()) {
    throw new Error(`Downloaded Run Bundle input must not be a symbolic link: ${source}`);
  }
  if (stats.isDirectory()) {
    return await copyLocatedRunBundle(source, destination);
  }
  if (!stats.isFile()) {
    throw new Error(`Downloaded Run Bundle input must be a file or directory: ${source}`);
  }
  if (stats.size > maximumRunBundleBytes) {
    throw new Error("Downloaded Run Bundle archive exceeds the 64 MiB limit");
  }

  const archive = await readFile(source);
  const format = detectArchiveFormat(archive);
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-run-input-"));
  try {
    const extracted = path.join(temporaryRoot, "contents");
    await extractRunArchiveFiles({ archive, format, destination: extracted });
    return await copyLocatedRunBundle(extracted, destination);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function detectArchiveFormat(archive: Uint8Array): "zip" | "tar.gz" {
  if (archive[0] === 0x1f && archive[1] === 0x8b) return "tar.gz";
  if (archive[0] === 0x50 && archive[1] === 0x4b) return "zip";
  throw new Error("Downloaded Run Bundle archive must be ZIP or tar.gz");
}

async function copyLocatedRunBundle(root: string, destination: string): Promise<DownloadedBundle> {
  const candidates: Array<{ type: "package" | "bundle"; directory: string }> = [];
  await findRunBundleCandidates(root, candidates, { count: 0 });
  if (candidates.length !== 1) {
    throw new Error(
      `Downloaded Run Bundle input must contain exactly one bundle or protected package; found ${candidates.length}`,
    );
  }
  const candidate = candidates[0];
  if (!candidate) throw new Error("Downloaded Run Bundle input is empty");
  return candidate.type === "package"
    ? await copyRunBundlePackage(candidate.directory, destination)
    : await copyValidatedRunBundle(candidate.directory, destination);
}

async function findRunBundleCandidates(
  directory: string,
  candidates: Array<{ type: "package" | "bundle"; directory: string }>,
  visited: { count: number },
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  visited.count += entries.length;
  if (visited.count > 1024) {
    throw new Error("Downloaded Run Bundle directory contains too many entries");
  }
  if (entries.some((entry) => entry.isSymbolicLink())) {
    throw new Error("Downloaded Run Bundle directory contains a symbolic link");
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "envelope.json")) {
    candidates.push({ type: "package", directory });
    return;
  }
  if (entries.some((entry) => entry.isFile() && entry.name === "run.json")) {
    candidates.push({ type: "bundle", directory });
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await findRunBundleCandidates(path.join(directory, entry.name), candidates, visited);
    }
  }
}
