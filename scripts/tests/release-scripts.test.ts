import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { releaseAssetForPlatform, releaseTargets } from "../../packages/cli/src/release/targets.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const dogfoodPrStateLookup = [
  'pr_state="$(gh pr list --head "$branch" --state all --limit 1 --json state --jq ',
  "'.[0].state // \"\"'",
  ')"',
].join("");
const excludedFixturePaths = new Set([
  ".cache",
  ".git",
  ".output",
  ".turbo",
  "dist",
  "node_modules",
]);

let tempDir: string;
beforeEach(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), "pipr-scripts-"));
  const binDir = path.join(tempDir, "bin");
  mkdirSync(binDir);
  const hkPath = path.join(binDir, "hk");
  writeFileSync(
    hkPath,
    [
      "#!/usr/bin/env bun",
      "const [util, command, file] = Bun.argv.slice(2);",
      'if (util !== "util" || command !== "check-conventional-commit" || !file) process.exit(2);',
      "const subject = (await Bun.file(file).text()).split(/\\r?\\n/, 1)[0] ?? '';",
      "const conventional = /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\\([^)]+\\))?!?: .+/.test(subject);",
      "process.exit(conventional ? 0 : 1);",
      "",
    ].join("\n"),
  );
  chmodSync(hkPath, 0o755);
});

afterEach(async () => {
  await rm(tempDir, { force: true, recursive: true });
});

describe("check-conventional-commit", () => {
  it("accepts conventional messages and generated commit subjects", () => {
    expect(
      runScript("scripts/check-conventional-commit.ts", ["--message", "feat: add release"]),
    ).toBe(0);
    expect(
      runScript("scripts/check-conventional-commit.ts", ["--message", "Merge branch main"]),
    ).toBe(0);
  });

  it("rejects generated-looking PR titles", () => {
    expect(
      runScript("scripts/check-conventional-commit.ts", ["--title", "feat: add release"]),
    ).toBe(0);
    expect(
      runScript("scripts/check-conventional-commit.ts", ["--title", "Merge branch main"]),
    ).not.toBe(0);
  });

  it("rejects invalid messages", () => {
    expect(
      runScript("scripts/check-conventional-commit.ts", ["--message", "release things"]),
    ).not.toBe(0);
  });

  it("checks every commit subject in a range", () => {
    const repository = path.join(tempDir, "repo");
    run("git", ["init", repository]);
    run("git", ["config", "user.email", "test@example.com"], { cwd: repository });
    run("git", ["config", "user.name", "Test"], { cwd: repository });
    write(path.join(repository, "file.txt"), "base\n");
    run("git", ["add", "file.txt"], { cwd: repository });
    run("git", ["commit", "-m", "chore: base"], { cwd: repository });
    const base = git(repository, "rev-parse", "HEAD");
    write(path.join(repository, "file.txt"), "base\nfeature\n");
    run("git", ["commit", "-am", "feat: valid"], { cwd: repository });
    expect(
      runScript(
        path.join(repoRoot, "scripts/check-conventional-commit.ts"),
        ["--range", `${base}..HEAD`],
        repository,
      ),
    ).toBe(0);

    write(path.join(repository, "file.txt"), "base\nfeature\nbad\n");
    run("git", ["commit", "-am", "bad subject"], { cwd: repository });
    expect(
      runScript(
        path.join(repoRoot, "scripts/check-conventional-commit.ts"),
        ["--range", `${base}..HEAD`],
        repository,
      ),
    ).not.toBe(0);
  });
});

describe("changed-scope", () => {
  it("fails open when a push base commit is unavailable", () => {
    const repository = changedScopeRepository("README.md");
    const head = git(repository, "rev-parse", "HEAD");
    const result = scriptResult(
      path.join(repoRoot, "scripts/changed-scope.ts"),
      ["docs"],
      repository,
      {
        EVENT_NAME: "push",
        GITHUB_OUTPUT: undefined,
        HEAD_SHA: head,
        PUSH_BEFORE_SHA: "f".repeat(40),
      },
    );

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe("changed=true");
  });

  it("limits docker scope to Docker image and container check inputs", () => {
    for (const file of [
      "packages/e2e/action-fixture.ts",
      "packages/e2e/action-metadata.ts",
      "packages/e2e/assertions.ts",
      "packages/e2e/check.ts",
      "packages/e2e/container-check.ts",
      "packages/e2e/fake-pi",
      "packages/e2e/package.json",
      "packages/e2e/pi-contract.ts",
      "packages/e2e/run.ts",
      "packages/e2e/scenarios.ts",
      "packages/e2e/webhook-health-fixture.ts",
      "deploy/webhook/compose.yml",
      "scripts/docker-e2e.ts",
    ]) {
      expect(dockerScopeChanged(file)).toBe(true);
    }

    for (const file of [
      "packages/e2e/assertions.test.ts",
      "packages/e2e/prompt-evals.test.ts",
      "packages/e2e/scenarios-cleanup.test.ts",
    ]) {
      expect(dockerScopeChanged(file)).toBe(false);
    }
  }, 15000);
});

describe("sync-release-lockfile", () => {
  it("normalizes Bun workspace metadata after a version bump", () => {
    const repository = copyRepositoryFixture();
    bumpReleaseFixture(repository, "0.1.1");
    run("bun", [path.join(repoRoot, "scripts/sync-release-lockfile.ts"), "--root", repository], {
      cwd: repoRoot,
    });
    const dogfoodPackage = JSON.parse(
      readFileSync(path.join(repository, ".pipr/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };
    const dogfoodSdkVersion = dogfoodPackage.dependencies?.["@usepipr/sdk"];
    if (!dogfoodSdkVersion) {
      throw new Error(".pipr/package.json dependency @usepipr/sdk is required");
    }
    const metadataCheck = scriptResult("scripts/check-release-metadata.ts", [], repository);
    if (metadataCheck.exitCode !== 0) {
      throw new Error(metadataCheck.stderr || metadataCheck.stdout || "metadata check failed");
    }

    const lockfile = readFileSync(path.join(repository, "bun.lock"), "utf8");
    expect(lockfile).toContain('"@usepipr/runtime": "0.1.1"');
    expect(lockfile).toContain('"@usepipr/sdk": "0.1.1"');
    expect(readFileSync(path.join(repository, ".pipr/package.json"), "utf8")).toContain(
      `"@usepipr/sdk": "${dogfoodSdkVersion}"`,
    );
    expect(readFileSync(path.join(repository, ".pipr/bun.lock"), "utf8")).toContain(
      `"@usepipr/sdk": "${dogfoodSdkVersion}"`,
    );
    expect(readFileSync(path.join(repository, ".pipr/bun.lock"), "utf8")).toContain(
      `"@usepipr/sdk@${dogfoodSdkVersion}"`,
    );
    expect(readFileSync(path.join(repository, "action.yml"), "utf8")).toContain(
      "docker://ghcr.io/somus/pipr:v0.1.1",
    );
    expect(readFileSync(path.join(repository, "deploy/webhook/compose.yml"), "utf8")).toContain(
      "image: ghcr.io/somus/pipr:v0.1.1",
    );
    expect(readFileSync(path.join(repository, ".github/workflows/pipr.yml"), "utf8")).toContain(
      "uses: somus/pipr@v0.1.1",
    );
  });
});

describe("release checksums", () => {
  it("writes SHA256SUMS for release binaries", () => {
    const repository = copyRepositoryFixture();
    const releaseDir = path.join(repository, "dist", "release");
    mkdirSync(releaseDir, { recursive: true });
    const binaryPath = path.join(releaseDir, "pipr-linux-x64");
    write(binaryPath, "#!/bin/sh\necho pipr\n");

    run("bun", [
      path.join(repoRoot, "packages/cli/build-release.ts"),
      "--host",
      "--outfile",
      binaryPath,
    ]);

    const expected = createHash("sha256").update(readFileSync(binaryPath)).digest("hex");
    const checksums = readFileSync(path.join(releaseDir, "SHA256SUMS"), "utf8");
    expect(checksums).toContain(`${expected}  pipr-linux-x64`);

    const cacheDir = path.join(tempDir, "host-skill-cache");
    const versionFlag = executableResult(binaryPath, ["--version"], tempDir);
    const versionCommand = executableResult(binaryPath, ["version"], tempDir);
    expect(versionFlag.exitCode, `${versionFlag.stdout}\n${versionFlag.stderr}`).toBe(0);
    expect(versionCommand.exitCode, `${versionCommand.stdout}\n${versionCommand.stderr}`).toBe(0);
    expect(versionFlag.stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(versionCommand.stdout).toBe(versionFlag.stdout);

    const skill = executableResult(binaryPath, ["skill"], tempDir, {
      PIPR_SKILL_CACHE_DIR: cacheDir,
    });
    expect(skill.exitCode, `${skill.stdout}\n${skill.stderr}`).toBe(0);
    expect(skill.stdout).toContain("BEGIN SKILL FILE: SKILL.md");
    expect(skill.stdout).toContain("BEGIN SKILL FILE: references/recipes.md");

    const skillPath = executableResult(binaryPath, ["skill", "path"], tempDir, {
      PIPR_SKILL_CACHE_DIR: cacheDir,
    });
    expect(skillPath.exitCode, `${skillPath.stdout}\n${skillPath.stderr}`).toBe(0);
    expect(readFileSync(path.join(skillPath.stdout.trim(), "SKILL.md"), "utf8")).toContain(
      "name: pipr-setup",
    );
  }, 30000);

  it("keeps updater asset names aligned with release targets", () => {
    const releaseAssetNames = releaseTargets
      .map((target) => releaseAssetForPlatform(target))
      .sort();
    expect(releaseAssetNames).toEqual(releaseTargets.map((target) => target.outfile).sort());
    expect(new Set(releaseAssetNames).size).toBe(releaseTargets.length);
  });
});

describe("CLI package bundled skills", () => {
  it("copies skill files through a staging directory", () => {
    const repository = copyRepositoryFixture();
    const distDir = path.join(repository, "packages/cli/dist");
    const skillsDir = path.join(distDir, "skills");
    writeCreatingDirs(path.join(skillsDir, "stale.txt"), "stale\n");

    run("bun", [path.join(repository, "packages/cli/src/release/copy-skills.ts")], {
      cwd: repository,
    });

    expect(readFileSync(path.join(skillsDir, "pipr-setup/SKILL.md"), "utf8")).toContain(
      "name: pipr-setup",
    );
    expect(existsSync(path.join(skillsDir, "stale.txt"))).toBe(false);
    expect(readdirSync(distDir).filter((entry) => entry.startsWith("skills-"))).toHaveLength(0);
  });

  it("copies skill files into package dist", () => {
    run("bun", ["run", "--cwd", "packages/cli", "build"], { cwd: repoRoot });

    const sourceDist = path.join(repoRoot, "packages/cli", "dist");
    expect(readFileSync(path.join(sourceDist, "skills/pipr-setup/SKILL.md"), "utf8")).toContain(
      "name: pipr-setup",
    );
    const isolatedDist = path.join(tempDir, "isolated-cli-dist");
    cpSync(sourceDist, isolatedDist, { recursive: true });
    symlinkSync(
      path.join(repoRoot, "packages/cli/node_modules"),
      path.join(isolatedDist, "node_modules"),
      "dir",
    );
    const cliPath = path.join(isolatedDist, "main.mjs");
    const cacheDir = path.join(realpathSync(tempDir), "dist-skill-cache");
    const skill = executableResult(cliPath, ["skill"], repoRoot, {
      PIPR_SKILL_CACHE_DIR: cacheDir,
    });
    expect(skill.exitCode, `${skill.stdout}\n${skill.stderr}`).toBe(0);
    expect(skill.stdout).toContain("BEGIN SKILL FILE: SKILL.md");
    expect(skill.stdout).toContain("BEGIN SKILL FILE: references/config-patterns.md");

    const skillPath = executableResult(cliPath, ["skill", "path"], repoRoot, {
      PIPR_SKILL_CACHE_DIR: cacheDir,
    });
    expect(skillPath.exitCode, `${skillPath.stdout}\n${skillPath.stderr}`).toBe(0);
    expect(
      readFileSync(path.join(skillPath.stdout.trim(), "references/recipes.md"), "utf8"),
    ).toContain("Pipr Recipe Selection");
  }, 30000);
});

describe("install.sh", () => {
  it("is published by the docs image at the hosted install URL path", () => {
    expect(readFileSync(path.join(repoRoot, "Dockerfile.docs"), "utf8")).toContain(
      "COPY install.sh /usr/share/nginx/html/install.sh",
    );
  });

  it("uses the hosted install URL in docs and generated recipe sources", () => {
    const oldInstallUrl = "https://raw.githubusercontent.com/somus/pipr/main/install.sh";
    const checkedFiles = [
      "README.md",
      "apps/docs/scripts/sync-recipes.ts",
      "apps/docs/src/routes/index.tsx",
      "apps/docs/content/docs/index.mdx",
      "apps/docs/content/docs/guide/quickstart.mdx",
      ...readdirSync(path.join(repoRoot, "apps/docs/content/docs/recipes"))
        .filter((entry) => entry.endsWith(".mdx"))
        .map((entry) => `apps/docs/content/docs/recipes/${entry}`),
    ];

    for (const file of checkedFiles) {
      expect(readFileSync(path.join(repoRoot, file), "utf8")).not.toContain(oldInstallUrl);
    }
  });

  it("verifies the downloaded binary checksum before install", () => {
    const fixture = installFixture({ validChecksum: true });
    const result = scriptResult("install.sh", [], repoRoot, {
      PATH: `${fixture.binDir}:${Bun.env.PATH ?? ""}`,
      PIPR_FAKE_RELEASE: fixture.releaseDir,
      PIPR_INSTALL_DIR: fixture.installDir,
      PIPR_VERSION: "v0.1.0",
    });

    expect(result.exitCode).toBe(0);
    expect(readFileSync(path.join(fixture.installDir, "pipr"), "utf8")).toContain("fake pipr");
  });

  it("rejects a binary with a mismatched checksum", () => {
    const fixture = installFixture({ validChecksum: false });
    const result = scriptResult("install.sh", [], repoRoot, {
      PATH: `${fixture.binDir}:${Bun.env.PATH ?? ""}`,
      PIPR_FAKE_RELEASE: fixture.releaseDir,
      PIPR_INSTALL_DIR: fixture.installDir,
      PIPR_VERSION: "v0.1.0",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("checksum mismatch");
  });
});

describe("check-release-metadata", () => {
  it("rejects a stale webhook deployment image pin", () => {
    const repository = copyRepositoryFixture();
    const composePath = path.join(repository, "deploy/webhook/compose.yml");
    write(
      composePath,
      readFileSync(composePath, "utf8").replace(
        "ghcr.io/somus/pipr:v0.3.8",
        "ghcr.io/somus/pipr:v0.0.0",
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects missing public package publish steps", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(
        "      - run: npm publish --access public\n        working-directory: packages/runtime\n",
        "",
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects unsafe authenticated release PR pushes", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release-please.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(" -c core.hooksPath=/dev/null push", " push"),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects published package dependency drift from the root catalog", () => {
    const repository = copyRepositoryFixture();
    const packagePath = path.join(repository, "packages/sdk/package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      dependencies: Record<string, string>;
    };
    pkg.dependencies.zod = "0.0.0";
    write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects Release Please dogfood SDK bumps", () => {
    const repository = copyRepositoryFixture();
    const configPath = path.join(repository, "release-please-config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      packages: { ".": { "extra-files": unknown[] } };
    };
    config.packages["."]["extra-files"].push({
      type: "json",
      path: ".pipr/package.json",
      jsonpath: "$.dependencies['@usepipr/sdk']",
    });
    write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects missing post-publish dogfood SDK automation", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(
        "      - name: Open dogfood SDK update PR\n",
        "      - name: Update dogfood SDK without PR\n",
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects protected main dogfood SDK pushes", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    const updateBranchPushRef = ['"HEAD:', "${", "branch", '}"'].join("");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(updateBranchPushRef, '"HEAD:main"'),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects dogfood PR automation that leaves closed PRs closed", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace('            gh pr reopen "$branch"\n', ""),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects dogfood PR automation that fails already merged PRs", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    const mergedPrMessage = [
      '            echo "Dogfood SDK update PR for ',
      "${",
      "branch",
      '} is already merged."',
    ].join("");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(
        [
          '          if [[ "$pr_state" == "MERGED" ]]; then',
          mergedPrMessage,
          "            exit 0",
          "          fi",
          "",
        ].join("\n"),
        "",
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects dogfood PR automation that swallows PR lookup failures", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replaceAll(
        dogfoodPrStateLookup,
        'pr_state="$(gh pr view "$branch" --json state --jq .state 2>/dev/null || true)"',
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects dogfood PR automation that reuses stale PR state after pushing", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    const stateLookupLine = `          ${dogfoodPrStateLookup}\n`;
    const workflow = readFileSync(workflowPath, "utf8");
    const lastLookup = workflow.lastIndexOf(stateLookupLine);
    if (lastLookup < 0) {
      throw new Error("dogfood PR state lookup is required");
    }
    write(
      workflowPath,
      `${workflow.slice(0, lastLookup)}${workflow.slice(lastLookup + stateLookupLine.length)}`,
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });
});

function runScript(script: string, args: string[], cwd = repoRoot): number {
  return scriptResult(script, args, cwd).exitCode;
}

function scriptResult(
  script: string,
  args: string[],
  cwd = repoRoot,
  env: Record<string, string | undefined> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const command = script.endsWith(".sh") ? ["sh", script, ...args] : ["bun", script, ...args];
  const result = Bun.spawnSync(command, {
    cwd,
    env: commandEnv(env),
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function executableResult(
  command: string,
  args: string[],
  cwd = repoRoot,
  env: Record<string, string | undefined> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: commandEnv(env),
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): void {
  const result = Bun.spawnSync([command, ...args], {
    cwd: options.cwd,
    env: commandEnv(options.env),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || `${command} failed`);
  }
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: commandEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString() || "git failed");
  }
  return result.stdout.toString().trim();
}

function dockerScopeChanged(relativePath: string): boolean {
  const repository = changedScopeRepository(relativePath);
  const base = git(repository, "rev-parse", "HEAD~1");
  const head = git(repository, "rev-parse", "HEAD");
  const result = scriptResult(
    path.join(repoRoot, "scripts/changed-scope.ts"),
    ["docker"],
    repository,
    {
      EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: undefined,
      PR_BASE_SHA: base,
      PR_HEAD_SHA: head,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "changed-scope failed");
  }
  return result.stdout.trim() === "changed=true";
}

function changedScopeRepository(relativePath: string): string {
  const repository = path.join(tempDir, `scope-${relativePath.replaceAll(/[/.]/g, "-")}`);
  run("git", ["init", repository]);
  run("git", ["config", "user.email", "test@example.com"], { cwd: repository });
  run("git", ["config", "user.name", "Test"], { cwd: repository });
  writeCreatingDirs(path.join(repository, relativePath), "before\n");
  run("git", ["add", relativePath], { cwd: repository });
  run("git", ["commit", "-m", "chore: base"], { cwd: repository });
  writeCreatingDirs(path.join(repository, relativePath), "after\n");
  run("git", ["commit", "-am", "chore: change"], { cwd: repository });
  return repository;
}

function commandEnv(
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    ...Bun.env,
    PATH: `${path.join(tempDir, "bin")}:${Bun.env.PATH ?? ""}`,
    TMPDIR: realpathSync(tempDir),
    ...extra,
  };
}

function installFixture(options: { validChecksum: boolean }): {
  binDir: string;
  installDir: string;
  releaseDir: string;
} {
  const binDir = path.join(tempDir, "install-bin");
  const installDir = path.join(tempDir, "install");
  const releaseDir = path.join(tempDir, "release");
  mkdirSync(binDir);
  mkdirSync(releaseDir);

  write(
    path.join(binDir, "uname"),
    '#!/bin/sh\nif [ "$1" = "-s" ]; then echo Linux; else echo x86_64; fi\n',
  );
  write(
    path.join(binDir, "curl"),
    [
      "#!/bin/sh",
      "out=",
      "url=",
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -o) out="$2"; shift 2 ;;',
      "    -*) shift ;;",
      '    *) url="$1"; shift ;;',
      "  esac",
      "done",
      'case "$url" in',
      '  *SHA256SUMS) cp "$PIPR_FAKE_RELEASE/SHA256SUMS" "$out" ;;',
      '  *pipr-linux-x64) cp "$PIPR_FAKE_RELEASE/pipr-linux-x64" "$out" ;;',
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
  );
  chmodSync(path.join(binDir, "uname"), 0o755);
  chmodSync(path.join(binDir, "curl"), 0o755);

  const binary = "#!/bin/sh\necho fake pipr\n";
  const binaryPath = path.join(releaseDir, "pipr-linux-x64");
  write(binaryPath, binary);
  const checksum = createHash("sha256").update(binary).digest("hex");
  write(
    path.join(releaseDir, "SHA256SUMS"),
    `${options.validChecksum ? checksum : "0".repeat(64)}  pipr-linux-x64\n`,
  );
  return { binDir, installDir, releaseDir };
}

function write(filePath: string, value: string): void {
  writeFileSync(filePath, value);
}

function writeCreatingDirs(filePath: string, value: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true });
  write(filePath, value);
}

function copyRepositoryFixture(): string {
  const repository = path.join(tempDir, "release");
  cpSync(repoRoot, repository, {
    filter: (source) => !source.split(path.sep).some((part) => excludedFixturePaths.has(part)),
    recursive: true,
  });
  return repository;
}

function bumpReleaseFixture(repository: string, version: string): void {
  for (const relativePath of [
    "package.json",
    "packages/sdk/package.json",
    "packages/runtime/package.json",
    "packages/cli/package.json",
  ]) {
    const filePath = path.join(repository, relativePath);
    const pkg = JSON.parse(readFileSync(filePath, "utf8")) as {
      version: string;
      dependencies?: Record<string, string>;
    };
    pkg.version = version;
    if (pkg.dependencies?.["@usepipr/sdk"]) {
      pkg.dependencies["@usepipr/sdk"] = version;
    }
    if (pkg.dependencies?.["@usepipr/runtime"]) {
      pkg.dependencies["@usepipr/runtime"] = version;
    }
    write(filePath, `${JSON.stringify(pkg, null, 2)}\n`);
  }

  for (const relativePath of [
    "action.yml",
    "README.md",
    "packages/runtime/src/config/init.ts",
    "packages/runtime/src/config/tests/init.test.ts",
    "packages/cli/src/tests/main.test.ts",
    "apps/docs/scripts/sync-recipes.ts",
  ]) {
    const filePath = path.join(repository, relativePath);
    write(filePath, readFileSync(filePath, "utf8").replaceAll("0.1.0", version));
  }
}
