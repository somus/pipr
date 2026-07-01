export function runGit(args: string[], cwd: string, maxBuffer?: number): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: process.env,
    maxBuffer,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    const failure = result.stderr?.toString().trim() || "unknown error";
    throw new Error(`git ${args.join(" ")} failed: ${failure}`);
  }
  return result.stdout.toString();
}
