import { lstat } from "node:fs/promises";
import path from "node:path";

export function resolveAllowedPath(root: string, filePath: string): string {
  const resolved = path.resolve(root, filePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path '${filePath}' resolves outside the workspace`);
  }
  return resolved;
}

export async function assertNoSymlinkPath(root: string, filePath: string): Promise<void> {
  const parts = filePath.split(/[\\/]/);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      throw new Error(`Path '${filePath}' crosses a symlink`);
    }
  }
}
