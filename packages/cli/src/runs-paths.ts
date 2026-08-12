import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { selectorFromGitRemote } from "./runs-selector.js";

export async function defaultLocalTraceStore(cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const remote = await selectorFromGitRemote(cwd).catch(() => undefined);
  const identity = remote?.repository ?? path.basename(cwd);
  const partition = `${identity.replace(/[^a-z0-9._-]+/gi, "-")}-${createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 12)}`;
  const stateRoot = await defaultPiprStateRoot(env);
  return path.join(stateRoot, "runs", partition);
}

export async function defaultPiprStateRoot(env: NodeJS.ProcessEnv): Promise<string> {
  const home = env.HOME ?? resolvedHomeDirectory();
  const stateRoot = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, "pipr")
    : process.platform === "darwin" && home
      ? path.join(home, "Library", "Application Support", "pipr")
      : home
        ? path.join(home, ".local", "state", "pipr")
        : path.join(os.tmpdir(), "pipr-state");
  return stateRoot;
}

function resolvedHomeDirectory(): string | undefined {
  try {
    return os.homedir() || undefined;
  } catch {
    return undefined;
  }
}
