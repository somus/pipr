import { chmod, chown, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function ensureSafeDirectory(directory: string): Promise<void> {
  try {
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Run bundle root must be a real directory: ${directory}`);
    }
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stats = await lstat(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Run bundle root must be a real directory: ${directory}`);
    }
  }
  await chmod(directory, 0o700);
}

export type DirectoryOwner = { uid: number; gid: number };

export async function nearestDirectoryOwner(directory: string): Promise<DirectoryOwner> {
  let candidate = directory;
  while (true) {
    try {
      const stats = await lstat(candidate);
      return { uid: stats.uid, gid: stats.gid };
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function preserveStoreOwnership(
  rootDirectory: string,
  bundleDirectory: string,
  owner: DirectoryOwner,
): Promise<void> {
  if (process.getuid?.() !== 0) return;
  await chownTree(bundleDirectory, owner);
  await chown(rootDirectory, owner.uid, owner.gid);
}

async function chownTree(directory: string, owner: DirectoryOwner): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await chownTree(entryPath, owner);
    await chown(entryPath, owner.uid, owner.gid);
  }
  await chown(directory, owner.uid, owner.gid);
}

export async function writePrivateFile(filePath: string, contents: string): Promise<void> {
  await writeFile(filePath, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(filePath, 0o600);
}

export async function writePrivateBuffer(filePath: string, contents: Buffer): Promise<void> {
  await writeFile(filePath, contents, { mode: 0o600 });
  await chmod(filePath, 0o600);
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
