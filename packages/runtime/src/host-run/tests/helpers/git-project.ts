import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "../../../diff/git.js";

export async function initGitRepoRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-git-project-"));
  await mkdir(rootDir, { recursive: true });
  runGit(["init", "--initial-branch=main"], rootDir);
  runGit(["config", "user.name", "pipr test"], rootDir);
  runGit(["config", "user.email", "pipr@example.test"], rootDir);
  runGit(["config", "core.hooksPath", "/dev/null"], rootDir);
  runGit(["config", "commit.gpgsign", "false"], rootDir);
  return rootDir;
}

export function commitGitProjectBase(rootDir: string): string {
  runGit(["add", "."], rootDir);
  runGit(["commit", "--no-verify", "-m", "base"], rootDir);
  return runGit(["rev-parse", "HEAD"], rootDir).trim();
}
