export function ensureCodeHostHeadCheckout(options: {
  rootDir: string;
  headSha: string;
  fetchRef: string;
}): void {
  if (!hasGitCommit(options.rootDir, options.headSha)) {
    runGit(options.rootDir, ["fetch", "--no-tags", "--depth=1", "origin", options.fetchRef]);
  }
  if (runGit(options.rootDir, ["rev-parse", "HEAD"]).trim() !== options.headSha) {
    runGit(options.rootDir, ["checkout", "--detach", options.headSha]);
  }
}

function hasGitCommit(rootDir: string, sha: string): boolean {
  try {
    runGit(rootDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function runGit(rootDir: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: rootDir,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
  }
  return result.stdout.toString();
}
