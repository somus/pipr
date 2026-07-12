export async function ensureCodeHostHeadCheckout(options: {
  rootDir: string;
  headSha: string;
  fetchRef: string;
  fetchRemote?: string;
}): Promise<void> {
  if (!(await hasGitCommit(options.rootDir, options.headSha))) {
    const remote = options.fetchRemote ?? "origin";
    try {
      await fetchGit(options.rootDir, remote, options.headSha);
    } catch {
      await fetchGit(options.rootDir, remote, options.fetchRef);
    }
    if (!(await hasGitCommit(options.rootDir, options.headSha))) {
      throw new Error(
        `Code host did not provide reviewed commit ${options.headSha} from ${options.fetchRef}`,
      );
    }
  }
  if ((await runGit(options.rootDir, ["rev-parse", "HEAD"])).trim() !== options.headSha) {
    await runGit(options.rootDir, ["checkout", "--detach", options.headSha]);
  }
}

async function fetchGit(rootDir: string, remote: string, ref: string): Promise<void> {
  await runGit(rootDir, ["fetch", "--no-tags", "--depth=1", remote, ref]);
}

async function hasGitCommit(rootDir: string, sha: string): Promise<boolean> {
  try {
    await runGit(rootDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function runGit(rootDir: string, args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: rootDir,
    env: process.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `git ${args.join(" ")} failed`);
  }
  return stdout;
}
