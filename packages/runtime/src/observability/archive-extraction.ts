import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Gunzip, Unzip, UnzipInflate } from "fflate";
import { copyValidatedRunBundle, type DownloadedBundle } from "./archive.js";
import { maximumRunBundleBytes } from "./types.js";

export async function extractRunArchive(options: {
  archive: Uint8Array;
  format: "zip" | "tar.gz";
  destination: string;
}): Promise<DownloadedBundle> {
  if (options.archive.byteLength > maximumRunBundleBytes) {
    throw new Error("Run archive exceeds the 64 MiB bundle limit");
  }
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-run-extract-"));
  const extractionRoot = path.join(temporaryRoot, "contents");
  await mkdir(extractionRoot, { mode: 0o700 });
  try {
    if (options.format === "zip") {
      await extractZip(options.archive, extractionRoot);
    } else {
      await extractTarGz(options.archive, extractionRoot);
    }
    const bundleRoot = await locateBundleRoot(extractionRoot);
    return await copyValidatedRunBundle(bundleRoot, options.destination);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function extractZip(archive: Uint8Array, destination: string): Promise<void> {
  rejectZipSymbolicLinks(archive);
  const files: Array<{ relativePath: string; chunks: Uint8Array[]; size: number }> = [];
  let expandedBytes = 0;
  let entryCount = 0;
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > 1024) throw new Error("Run ZIP contains too many entries");
    const directory = file.name.endsWith("/");
    validateArchivePath(file.name, directory);
    const extracted = { relativePath: file.name, chunks: [] as Uint8Array[], size: 0 };
    file.ondata = (error, chunk) => {
      if (error) throw error;
      expandedBytes += chunk.byteLength;
      if (expandedBytes > maximumRunBundleBytes) {
        file.terminate();
        throw new Error("Run archive expansion exceeds the 64 MiB bundle limit");
      }
      if (!directory && chunk.byteLength > 0) {
        extracted.chunks.push(chunk);
        extracted.size += chunk.byteLength;
      }
    };
    if (!directory) files.push(extracted);
    file.start();
  });
  unzip.register(UnzipInflate);
  unzip.push(archive, true);
  for (const file of files) {
    await writeArchiveFile(destination, file.relativePath, concatenate(file.chunks, file.size));
  }
}

function rejectZipSymbolicLinks(archive: Uint8Array): void {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const endRecord = findZipEndRecord(view, archive.byteLength);
  const entries = view.getUint16(endRecord + 10, true);
  let offset = view.getUint32(endRecord + 16, true);
  if (entries === 0xffff || offset === 0xffffffff) {
    throw new Error("Run ZIP64 archives are not supported");
  }
  if (entries > 1024) throw new Error("Run ZIP contains too many entries");
  for (let index = 0; index < entries; index += 1) {
    offset = validateZipDirectoryEntry(archive, view, offset, endRecord);
  }
}

function findZipEndRecord(view: DataView, archiveBytes: number): number {
  for (let offset = archiveBytes - 22; offset >= Math.max(0, archiveBytes - 65_557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) return offset;
  }
  throw new Error("Run ZIP is missing its central directory");
}

function validateZipDirectoryEntry(
  archive: Uint8Array,
  view: DataView,
  offset: number,
  endRecord: number,
): number {
  if (offset + 46 > endRecord || view.getUint32(offset, true) !== 0x02014b50) {
    throw new Error("Run ZIP has an invalid central directory");
  }
  const nameLength = view.getUint16(offset + 28, true);
  const extraLength = view.getUint16(offset + 30, true);
  const commentLength = view.getUint16(offset + 32, true);
  const unixMode = view.getUint32(offset + 38, true) >>> 16;
  if ((unixMode & 0o170000) === 0o120000) {
    const name = new TextDecoder().decode(archive.subarray(offset + 46, offset + 46 + nameLength));
    throw new Error(`Run ZIP contains a symbolic link: ${name}`);
  }
  return offset + 46 + nameLength + extraLength + commentLength;
}

async function extractTarGz(archive: Uint8Array, destination: string): Promise<void> {
  const tar = expandTarGz(archive);
  let offset = 0;
  let entryCount = 0;
  while (offset + 512 <= tar.byteLength) {
    const entry = tarEntry(tar, offset);
    if (!entry) break;
    entryCount += 1;
    if (entryCount > 1024) throw new Error("Run tar contains too many entries");
    await writeTarEntry(destination, entry);
    offset = entry.nextOffset;
  }
}

function expandTarGz(archive: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let expandedBytes = 0;
  const gunzip = new Gunzip((chunk) => {
    expandedBytes += chunk.byteLength;
    if (expandedBytes > maximumRunBundleBytes) {
      throw new Error("Run archive expansion exceeds the 64 MiB bundle limit");
    }
    chunks.push(chunk);
  });
  gunzip.push(archive, true);
  return concatenate(chunks, expandedBytes);
}

type TarEntry = {
  relativePath: string;
  type: number;
  contents: Uint8Array;
  nextOffset: number;
};

function tarEntry(tar: Uint8Array, offset: number): TarEntry | undefined {
  const header = tar.subarray(offset, offset + 512);
  if (header.every((byte) => byte === 0)) return undefined;
  const name = tarString(header.subarray(0, 100));
  const prefix = tarString(header.subarray(345, 500));
  const relativePath = prefix ? `${prefix}/${name}` : name;
  validateArchivePath(relativePath);
  const size = Number.parseInt(tarString(header.subarray(124, 136)).trim() || "0", 8);
  if (!Number.isSafeInteger(size) || size < 0) throw new Error("Run tar has an invalid size");
  const bodyStart = offset + 512;
  const bodyEnd = bodyStart + size;
  if (bodyEnd > tar.byteLength) throw new Error("Run tar entry exceeds the archive bounds");
  return {
    relativePath,
    type: header[156],
    contents: tar.subarray(bodyStart, bodyEnd),
    nextOffset: bodyStart + Math.ceil(size / 512) * 512,
  };
}

async function writeTarEntry(destination: string, entry: TarEntry): Promise<void> {
  if (entry.type === 0 || entry.type === "0".charCodeAt(0)) {
    await writeArchiveFile(destination, entry.relativePath, entry.contents);
    return;
  }
  if (entry.type !== "5".charCodeAt(0)) {
    throw new Error(`Run tar contains an unsupported link or entry: ${entry.relativePath}`);
  }
}

async function writeArchiveFile(
  root: string,
  relativePath: string,
  contents: Uint8Array,
): Promise<void> {
  validateArchivePath(relativePath);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`Run archive path escapes the destination: ${relativePath}`);
  }
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, contents, { mode: 0o600 });
  await chmod(target, 0o600);
}

function validateArchivePath(relativePath: string, directory = false): void {
  const pathToValidate = directory ? relativePath.slice(0, -1) : relativePath;
  if (
    !pathToValidate ||
    pathToValidate.startsWith("/") ||
    pathToValidate.includes("\\") ||
    pathToValidate
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Run archive contains an unsafe path: ${relativePath}`);
  }
}

async function locateBundleRoot(root: string): Promise<string> {
  const manifests: string[] = [];
  await findManifests(root, root, manifests);
  if (manifests.length !== 1) {
    throw new Error(`Run archive must contain exactly one run.json; found ${manifests.length}`);
  }
  return path.dirname(manifests[0]);
}

async function findManifests(root: string, directory: string, manifests: string[]): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error("Run archive extraction produced a symlink");
    if (entry.isDirectory()) {
      await findManifests(root, target, manifests);
    } else if (entry.isFile() && entry.name === "run.json") {
      if (!target.startsWith(`${root}${path.sep}`))
        throw new Error("Run manifest escaped extraction root");
      manifests.push(target);
    }
  }
}

function tarString(bytes: Uint8Array): string {
  const zero = bytes.indexOf(0);
  return new TextDecoder().decode(zero === -1 ? bytes : bytes.subarray(0, zero));
}

function concatenate(chunks: Uint8Array[], size: number): Uint8Array {
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
