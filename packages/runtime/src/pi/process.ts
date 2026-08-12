import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { chmod, chown, cp, lstat, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RunAgentEvent } from "../observability/types.js";
import { createDiffContextCoverageTracker } from "./diff-context-coverage-observer.js";
import { PiOutputCollector } from "./output.js";
import type {
  PiProcessIdentity,
  PiRunOptions,
  PiRunResult,
  PiRunSandbox,
  PiStreamLimits,
  PiWorkspaceScope,
} from "./types.js";

const ignoredWorkspacePaths = new Set([
  ".git",
  ".pipr-runs",
  "node_modules",
  "dist",
  ".turbo",
  ".fallow",
  "coverage",
]);
const processTerminationGraceMs = 250;
const piSandboxUidEnv = "PIPR_PI_SANDBOX_UID";
const piSandboxGidEnv = "PIPR_PI_SANDBOX_GID";

export async function createReadOnlyWorkspace(workspace: string): Promise<string> {
  const destination = await mkdtemp(path.join(os.tmpdir(), "pipr-workspace-"));
  await copyWorkspace(workspace, destination);
  await chmodRecursive(destination, 0o555);
  return destination;
}

export async function createPiRunSandbox(
  workspace: string,
  preparedWorkspace?: string,
): Promise<PiRunSandbox> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-"));
  try {
    const runWorkspace = preparedWorkspace ?? path.join(root, "workspace");
    const home = path.join(root, "home");
    const sessionDir = path.join(root, "sessions");
    const tmp = path.join(root, "tmp");
    await mkdir(home, { recursive: true });
    await mkdir(sessionDir, { recursive: true });
    await mkdir(tmp, { recursive: true });
    if (!preparedWorkspace) {
      await copyWorkspace(workspace, runWorkspace);
    }
    return { root, workspace: runWorkspace, home, sessionDir, tmp };
  } catch (error) {
    await removeSandboxRoot(root);
    throw error;
  }
}

export async function createPiWorkspaceSnapshot(
  workspace: string,
): Promise<Pick<PiRunSandbox, "root" | "workspace">> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pipr-pi-workspace-"));
  const snapshotWorkspace = path.join(root, "workspace");
  try {
    await copyWorkspace(workspace, snapshotWorkspace);
    await sealReadOnlyTree(root, 0, 0);
    return { root, workspace: snapshotWorkspace };
  } catch (error) {
    await removeSandboxRoot(root);
    throw error;
  }
}

export function assertWorkspaceScope(
  sourceWorkspace: string,
  processIdentity: PiProcessIdentity | undefined,
  scope: PiWorkspaceScope | undefined,
): void {
  if (!scope) {
    return;
  }
  if (path.resolve(sourceWorkspace) !== scope.sourceWorkspace) {
    throw new Error("scoped Pi runner cannot be used with a different source workspace");
  }
  if (
    scope.processIdentity &&
    (processIdentity?.uid !== scope.processIdentity.uid ||
      processIdentity?.gid !== scope.processIdentity.gid)
  ) {
    throw new Error("scoped Pi runner cannot be used with a different sandbox identity");
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

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    started: number;
    processIdentity?: PiProcessIdentity;
    timeoutSeconds?: number;
    streamLimits: PiStreamLimits;
    eventObserver?: (event: RunAgentEvent) => void;
    diffContext?: PiRunOptions["diffContext"];
  },
): Promise<PiRunResult> {
  return new Promise((resolve, reject) => {
    let timedOut = false;
    let streamFailure: string | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let terminationTimeout: NodeJS.Timeout | undefined;
    const detached = process.platform !== "win32";
    const spawnCommand = options.processIdentity ? "su-exec" : command;
    const spawnArgs = options.processIdentity
      ? [
          `${options.processIdentity.uid}:${options.processIdentity.gid}`,
          "env",
          `HOME=${options.env.HOME ?? ""}`,
          command,
          ...args,
        ]
      : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd: options.cwd,
      detached,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = new PiOutputCollector(
      options.streamLimits,
      options.eventObserver,
      options.diffContext ? createDiffContextCoverageTracker(options.diffContext) : undefined,
    );
    let stderr = "";
    let stderrBytes = 0;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const failure = stdout.push(chunk);
      if (failure) {
        failStream(failure);
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (streamFailure || timedOut) {
        return;
      }
      const nextBytes = stderrBytes + Buffer.byteLength(chunk, "utf8");
      if (nextBytes > options.streamLimits.maxStderrBytes) {
        failStream("Pi stderr exceeded the output limit");
        return;
      }
      stderr += chunk;
      stderrBytes = nextBytes;
    });
    const failStream = (reason: string) => {
      if (streamFailure || timedOut) {
        return;
      }
      streamFailure = reason;
      stderr = "";
      stderrBytes = 0;
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      terminateProcessGroup();
    };
    const terminateProcessGroup = () => {
      killProcessGroup(child, "SIGTERM");
      if (!terminationTimeout) {
        terminationTimeout = setTimeout(() => {
          killProcessGroup(child, "SIGKILL");
        }, processTerminationGraceMs);
      }
    };
    if (options.timeoutSeconds !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminateProcessGroup();
      }, options.timeoutSeconds * 1000);
    }
    child.on("error", reject);
    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve(
        finalizeProcessResult({
          collector: stdout,
          stderr,
          exitCode,
          timedOut,
          streamFailure,
          timeoutSeconds: options.timeoutSeconds,
          durationMs: Date.now() - options.started,
        }),
      );
    });
  });
}

function finalizeProcessResult(options: {
  collector: PiOutputCollector;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  streamFailure: string | undefined;
  timeoutSeconds: number | undefined;
  durationMs: number;
}): PiRunResult {
  const collected = options.collector.finish();
  const streamFailure = options.streamFailure ?? options.collector.failure();
  if (options.timedOut) {
    return {
      ...collected,
      stderr: `${options.stderr ? `${options.stderr}\n` : ""}Pi timed out after ${options.timeoutSeconds}s`,
      exitCode: 124,
      durationMs: options.durationMs,
    };
  }
  if (streamFailure) {
    return {
      stdout: "",
      stderr: streamFailure,
      exitCode: 1,
      durationMs: options.durationMs,
      ...(collected.stream ? { stream: collected.stream } : {}),
      ...(collected.diffContextCoverage
        ? { diffContextCoverage: collected.diffContextCoverage }
        : {}),
    };
  }
  return {
    ...collected,
    stderr: options.stderr,
    exitCode: options.exitCode ?? 1,
    durationMs: options.durationMs,
  };
}

function killProcessGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, signal);
      return;
    }
    child.kill(signal);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : "";
    if (code === "ESRCH") {
      return;
    }
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
      const first = relative.split(path.sep)[0];
      return !ignoredWorkspacePaths.has(first ?? "") && !(await lstat(source)).isSymbolicLink();
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

async function sealReadOnlyTree(target: string, uid: number, gid: number): Promise<void> {
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
