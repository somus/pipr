export async function ensureCodeHostHeadCheckout(options: {
  rootDir: string;
  headSha: string;
  fetchRef: string;
  fetchRemote?: string;
  fetchEnv?: NodeJS.ProcessEnv;
}): Promise<void> {
  await ensureCodeHostCommit({
    rootDir: options.rootDir,
    commitSha: options.headSha,
    fetchRef: options.fetchRef,
    fetchRemote: options.fetchRemote,
    fetchEnv: options.fetchEnv,
  });
  if ((await runGit(options.rootDir, ["rev-parse", "HEAD"])).trim() !== options.headSha) {
    await runGit(options.rootDir, ["checkout", "--detach", options.headSha]);
  }
}

export async function ensureCodeHostCommit(options: {
  rootDir: string;
  commitSha: string;
  fetchRef: string;
  fetchRemote?: string;
  fetchEnv?: NodeJS.ProcessEnv;
}): Promise<void> {
  if (await hasGitCommit(options.rootDir, options.commitSha)) return;
  const remote = options.fetchRemote ?? "origin";
  try {
    await fetchGit(options.rootDir, remote, options.commitSha, options.fetchEnv);
  } catch {
    await fetchGit(options.rootDir, remote, options.fetchRef, options.fetchEnv);
  }
  if (!(await hasGitCommit(options.rootDir, options.commitSha))) {
    throw new Error(
      `Code host did not provide commit ${options.commitSha} from ${options.fetchRef}`,
    );
  }
}

async function fetchGit(
  rootDir: string,
  remote: string,
  ref: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const shallow = (await runGit(rootDir, ["rev-parse", "--is-shallow-repository"], env)).trim();
  await runGit(
    rootDir,
    ["fetch", "--no-tags", ...(shallow === "true" ? ["--unshallow"] : []), remote, ref],
    env,
  );
}

async function hasGitCommit(rootDir: string, sha: string): Promise<boolean> {
  try {
    await runGit(rootDir, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function runGit(rootDir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd: rootDir,
    env: { ...process.env, ...env },
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
