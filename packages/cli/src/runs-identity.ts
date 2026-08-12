import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { defaultPiprStateRoot } from "./runs-paths.js";

export async function resolveIdentityContents(
  explicitPaths: string[] | undefined,
  context: { env: NodeJS.ProcessEnv; cwd: string },
): Promise<{ values: string[]; explicit: boolean }> {
  const configured = explicitPaths?.length
    ? explicitPaths
    : context.env.PIPR_RUN_AGE_IDENTITY
      ? [context.env.PIPR_RUN_AGE_IDENTITY]
      : [];
  if (configured.length > 0) {
    return {
      values: await Promise.all(
        configured.map((identityPath) => readIdentity(identityPath, context.cwd)),
      ),
      explicit: true,
    };
  }
  const defaultPath = path.join(
    await defaultPiprStateRoot(context.env),
    "keys",
    "run-observability.agekey",
  );
  try {
    return { values: [await readIdentity(defaultPath, context.cwd)], explicit: false };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { values: [], explicit: false };
    }
    throw error;
  }
}

async function readIdentity(identityPath: string, cwd: string): Promise<string> {
  const resolved = path.resolve(cwd, identityPath);
  const stats = await lstat(resolved);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Run Bundle identity must be a regular file: ${resolved}`);
  }
  const identity = (await readFile(resolved, "utf8")).trim();
  if (!identity) throw new Error(`Run Bundle identity is empty: ${resolved}`);
  return identity;
}

export async function ensurePrivateParent(directory: string): Promise<void> {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  await requireKeyDirectory(directory);
  if (created !== undefined) await chmod(directory, 0o700);
}

async function requireKeyDirectory(directory: string): Promise<void> {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Run Bundle key directory must be a real directory: ${directory}`);
  }
}
