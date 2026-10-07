export class GitOutputLimitError extends Error {
  constructor(readonly limitBytes: number) {
    super(`git output exceeded ${limitBytes} byte limit`);
    this.name = "GitOutputLimitError";
  }
}

/** Runs git in `cwd` with `env` (the process environment by default), so callers' injected environments reach git. */
export function runGit(
  args: string[],
  cwd: string,
  options: { maxBuffer?: number; env?: NodeJS.ProcessEnv } = {},
): string {
  const { maxBuffer } = options;
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: options.env ?? process.env,
    maxBuffer,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitedDueToMaxBuffer && maxBuffer !== undefined) {
    throw new GitOutputLimitError(maxBuffer);
  }
  if (result.exitCode !== 0) {
    const failure = result.stderr?.toString().trim() || "unknown error";
    throw new Error(`git ${args.join(" ")} failed: ${failure}`);
  }
  return result.stdout.toString();
}
