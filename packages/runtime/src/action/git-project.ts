import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveContainedConfigDir } from "../config/paths.js";
import { type LoadedRuntimeProject, loadRuntimeProject } from "../config/project.js";
import { runGit } from "../diff/git.js";

type GitTreeEntry = {
  mode: string;
  path: string;
};

export async function loadRuntimeProjectFromGitCommit(options: {
  rootDir: string;
  configDir?: string;
  commitSha: string;
  env?: NodeJS.ProcessEnv;
}): Promise<LoadedRuntimeProject & { trustedConfigSha: string; trustedConfigHash: string }> {
  const configDir = resolveContainedConfigDir(options);
  const files = listConfigFilesAtCommit(options.rootDir, options.commitSha, configDir.gitPath);
  if (files.length === 0) {
    throw new Error(
      `${configDir.configDir}/config.ts is required at base commit ${options.commitSha}`,
    );
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-base-config-"));
  try {
    const hash = new Bun.CryptoHasher("sha256");
    for (const file of files) {
      assertRegularFile(file, options.commitSha);
      const relativePath = relativeGitPath(configDir.gitPath, file.path);
      const targetPath = path.join(
        tempRoot,
        configDir.relativeConfigDir,
        ...relativePath.split("/"),
      );
      const contents = showFileAtCommit(options.rootDir, options.commitSha, file.path);
      hash.update(relativePath);
      hash.update("\0");
      hash.update(contents);
      hash.update("\0");
      await mkdir(path.dirname(targetPath), { recursive: true });
      await Bun.write(targetPath, contents);
    }
    return {
      ...(await loadRuntimeProject({
        rootDir: tempRoot,
        configDir: configDir.relativeConfigDir,
        env: options.env,
        requireProviderEnv: false,
      })),
      trustedConfigSha: options.commitSha,
      trustedConfigHash: hash.digest("hex"),
    };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function listConfigFilesAtCommit(
  rootDir: string,
  commitSha: string,
  gitPath: string,
): GitTreeEntry[] {
  const output = runGit(["ls-tree", "-r", "-z", commitSha, "--", gitPath], rootDir);
  return output
    .split("\0")
    .filter(Boolean)
    .map((entry) => parseGitTreeEntry(entry, commitSha));
}

function parseGitTreeEntry(entry: string, commitSha: string): GitTreeEntry {
  const separatorIndex = entry.indexOf("\t");
  if (separatorIndex === -1) {
    throw new Error(`Could not parse git tree entry at ${commitSha}: ${entry}`);
  }
  const metadata = entry.slice(0, separatorIndex);
  const filePath = entry.slice(separatorIndex + 1);
  const [mode = ""] = metadata.split(" ");
  if (!mode || !filePath) {
    throw new Error(`Could not parse git tree entry at ${commitSha}: ${entry}`);
  }
  return { mode, path: filePath };
}

function assertRegularFile(file: GitTreeEntry, commitSha: string): void {
  if (file.mode !== "100644" && file.mode !== "100755") {
    throw new Error(`${file.path}: only regular config files are supported at ${commitSha}`);
  }
}

function relativeGitPath(root: string, filePath: string): string {
  const relative = root === "." ? filePath : path.posix.relative(root, filePath);
  assertRelativeGitPath(root, filePath, relative);
  return relative;
}

function assertRelativeGitPath(root: string, filePath: string, relative: string): void {
  if (!relative || relative.startsWith("..") || path.posix.isAbsolute(relative)) {
    throw new Error(`${filePath}: git path escaped configDir ${root}`);
  }
}

function showFileAtCommit(rootDir: string, commitSha: string, filePath: string): string {
  return runGit(["show", `${commitSha}:${filePath}`], rootDir);
}
