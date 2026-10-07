import { chmod, chown, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PiProcessIdentity } from "./types.js";

export type PiRunSandbox = {
  root: string;
  workspace: string;
  home: string;
  sessionDir: string;
  tmp: string;
};

/** Top-level workspace entries left out of the sandbox copy. */
const ignoredWorkspacePaths = new Set([
  ".pipr-runs",
  "node_modules",
  "dist",
  ".turbo",
  ".fallow",
  "coverage",
]);
const piSandboxUidEnv = "PIPR_PI_SANDBOX_UID";
const piSandboxGidEnv = "PIPR_PI_SANDBOX_GID";

export async function createPiRunSandbox(workspace: string): Promise<PiRunSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-"));
  try {
    const runWorkspace = path.join(root, "workspace");
    const home = path.join(root, "home");
    const sessionDir = path.join(root, "sessions");
    const tmp = path.join(root, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(tmp, { recursive: true });
    await copyWorkspace(workspace, runWorkspace);
    return { root, workspace: runWorkspace, home, sessionDir, tmp };
  } catch (error) {
    await removeSandboxRoot(root);
    throw error;
  }
}

export async function sealPiRunSandbox(
  sandbox: PiRunSandbox,
  processIdentity: PiProcessIdentity | undefined,
): Promise<void> {
  if (!processIdentity) {
    await chmodRecursive(sandbox.workspace, 0o555);
    return;
  }
  await sealReadOnlyTree(sandbox.root, 0, 0);
  for (const directory of [sandbox.home, sandbox.sessionDir, sandbox.tmp]) {
    await chown(directory, processIdentity.uid, processIdentity.gid);
    await chmod(directory, 0o700);
  }
}

export function resolvePiProcessIdentity(env: NodeJS.ProcessEnv): PiProcessIdentity | undefined {
  const uidValue = env[piSandboxUidEnv];
  const gidValue = env[piSandboxGidEnv];
  if (uidValue === undefined && gidValue === undefined) {
    return undefined;
  }
  if (uidValue === undefined || gidValue === undefined) {
    throw new Error(`${piSandboxUidEnv} and ${piSandboxGidEnv} must be configured together`);
  }
  const uid = positiveIntegerEnv(piSandboxUidEnv, uidValue);
  const gid = positiveIntegerEnv(piSandboxGidEnv, gidValue);
  return process.getuid?.() === 0 ? { uid, gid } : undefined;
}

export async function removeSandboxRoot(root: string): Promise<void> {
  try {
    await chmodRecursive(root, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function positiveIntegerEnv(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

async function copyWorkspace(sourceWorkspace: string, destination: string): Promise<void> {
  await cp(sourceWorkspace, destination, {
    recursive: true,
    filter: async (source) => {
      const relative = path.relative(sourceWorkspace, source);
      if (!relative) {
        return true;
      }
      const parts = relative.split(path.sep);
      // Repository metadata is never copied: neither the root `.git` nor a nested repository's or submodule's.
      if (parts.includes(".git") || ignoredWorkspacePaths.has(parts[0] ?? "")) {
        return false;
      }
      return !(await lstat(source)).isSymbolicLink();
    },
  });
}

async function chmodRecursive(target: string, mode: number): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    return;
  }
  await chmod(target, mode);
  if (!stats.isDirectory()) {
    return;
  }
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await chmodRecursive(path.join(target, entry.name), mode);
  }
}

export async function sealReadOnlyTree(target: string, uid: number, gid: number): Promise<void> {
  const stats = await lstat(target);
  if (stats.isSymbolicLink()) {
    return;
  }
  await chown(target, uid, gid);
  await chmod(target, stats.isDirectory() ? 0o555 : 0o444);
  if (!stats.isDirectory()) {
    return;
  }
  const entries = await readdir(target, { withFileTypes: true });
  for (const entry of entries) {
    await sealReadOnlyTree(path.join(target, entry.name), uid, gid);
  }
}
