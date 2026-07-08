import { describe, expect, it } from "bun:test";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import cliPackage from "../../package.json" with { type: "json" };
import { embeddedSdkDeclaration, readSdkDeclarationModules } from "../release/sdk-declaration.js";
import { runMain } from "../runner.js";
import {
  type BundledSkill,
  containedSkillFilePath,
  readBundledSkillCatalog,
  singleBundledSkill,
} from "../skill-catalog.js";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliProjectDir = path.resolve(testDir, "../..");
const repoRoot = path.resolve(cliProjectDir, "../..");
const cliPath = path.join(cliProjectDir, "src", "main.ts");

describe("pipr CLI", () => {
  it("prints update notices to stderr before running CLI commands", async () => {
    const events: Array<{ stream: "stdout" | "stderr"; message: string }> = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (message?: unknown) => {
      events.push({ stream: "stdout", message: String(message) });
    };
    console.error = (message?: unknown) => {
      events.push({ stream: "stderr", message: String(message) });
    };
    try {
      await runMain({
        argv: ["bun", "pipr", "version"],
        env: {},
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9"),
      });
      await runMain({
        argv: ["bun", "pipr", "skill"],
        env: {},
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9"),
      });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const notice = `pipr 9.9.9 is available (current ${cliPackage.version}). Run \`pipr update\` for release binaries, or reinstall @usepipr/cli with npm/Bun.`;
    expect(events[0]).toEqual({ stream: "stderr", message: notice });
    expect(events[1]).toEqual({ stream: "stdout", message: cliPackage.version });
    expect(events[2]).toEqual({ stream: "stderr", message: notice });
    expect(events[3]?.stream).toBe("stdout");
    expect(events[3]?.message).toContain("BEGIN SKILL FILE: SKILL.md");
  });

  it("does not check for update notices before update commands", async () => {
    const requests: string[] = [];
    const notices: string[] = [];

    await expect(
      runMain({
        argv: ["bun", "pipr", "update"],
        env: {},
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
        writeUpdateNotice(message) {
          notices.push(message);
        },
      }),
    ).rejects.toThrow("pipr update only supports compiled GitHub Release binaries");

    expect(requests).toEqual([]);
    expect(notices).toEqual([]);

    await expect(
      runMain({
        argv: ["bun", "pipr", "--", "update"],
        env: {},
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
        writeUpdateNotice(message) {
          notices.push(message);
        },
      }),
    ).rejects.toThrow("pipr update only supports compiled GitHub Release binaries");

    expect(requests).toEqual([]);
    expect(notices).toEqual([]);

    await runMain({
      argv: ["bun", "pipr", "update", "--help"],
      env: { GITHUB_ACTIONS: "true", PIPR_UPDATE_NOTICE: "1" },
      updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
      writeUpdateNotice(message) {
        notices.push(message);
      },
    });
    await runMain({
      argv: ["bun", "pipr", "help", "update"],
      env: { GITHUB_ACTIONS: "true", PIPR_UPDATE_NOTICE: "1" },
      updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
      writeUpdateNotice(message) {
        notices.push(message);
      },
    });

    expect(requests).toEqual([]);
    expect(notices).toEqual([]);
  });

  it("skips update notices when disabled or running in CI by default", async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
      const skippedNoticeEnvs = [
        { PIPR_UPDATE_NOTICE: "0" },
        { CI: "true" },
        { CI: "1" },
        { GITHUB_ACTIONS: "false" },
      ];
      for (const env of skippedNoticeEnvs) {
        const requests: string[] = [];
        const notices: string[] = [];

        await runMain({
          argv: ["bun", "pipr", "version"],
          env,
          updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
          writeUpdateNotice(message) {
            notices.push(message);
          },
        });

        expect(requests).toEqual([]);
        expect(notices).toEqual([]);
      }

      const requests: string[] = [];
      const notices: string[] = [];
      await runMain({
        argv: ["bun", "pipr", "version"],
        env: { CI: "true", PIPR_UPDATE_NOTICE: "1" },
        updateNoticeFetch: fakeLatestReleaseFetch("9.9.9", requests),
        writeUpdateNotice(message) {
          notices.push(message);
        },
      });

      expect(requests).toEqual(["https://api.github.com/repos/somus/pipr/releases/latest"]);
      expect(notices).toHaveLength(1);
    } finally {
      console.log = originalLog;
    }
  });

  it("prints the CLI version", async () => {
    const flag = await runCli(["--version"]);
    const command = await runCli(["version"]);

    expect(flag.exitCode, `${flag.stdout}\n${flag.stderr}`).toBe(0);
    expect(command.exitCode, `${command.stdout}\n${command.stderr}`).toBe(0);
    expect(flag.stdout).toBe(`${cliPackage.version}\n`);
    expect(command.stdout).toBe(`${cliPackage.version}\n`);
    expect(flag.stderr).toBe("");
    expect(command.stderr).toBe("");
  });

  it("prints TS-first subcommands", async () => {
    const result = await runCli(["--help"]);
    const action = await runCli(["action", "--help"]);

    expect(result.exitCode).toBe(0);
    expect(action.exitCode).toBe(0);
    expect(result.stdout).toContain("Start here (for AI agents):");
    expect(result.stdout).toContain("pipr skill");
    expect(result.stdout).toContain("init [options]");
    expect(result.stdout).toContain("check [options]");
    expect(result.stdout).toContain("inspect [options]");
    expect(result.stdout).toContain("review [options]");
    expect(result.stdout).toContain("skill");
    expect(result.stdout).toContain("update");
    expect(result.stdout).toContain("version");
    expect(result.stdout).not.toContain("run [options] <name>");
    const init = await runCli(["init", "--help"]);
    expect(init.stdout).toContain("--adapters <adapters>");
    expect(init.stdout).toContain("--recipe <recipe>");
    expect(init.stdout).toContain("--minimal");
    expect(init.stdout).toContain("github");
    expect(init.stdout).toContain("none");
    expect(init.stdout).toContain("multi-agent-review");
    expect(action.stdout).toContain("--config-dir <dir>");
    expect(action.stdout).not.toContain("--provider <name>");
  });

  it("prints no-args help without failing inside GitHub Actions", async () => {
    const result = await runCli([], { GITHUB_ACTIONS: "true" });

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Usage: pipr");
    expect(result.stdout).toContain("Start here (for AI agents):");
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("::error::");
  });

  it("does not self-update when running from source", async () => {
    const result = await runCli(["update"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("pipr update only supports compiled GitHub Release binaries");
    expect(result.stderr).toContain("npm install -g @usepipr/cli@latest");
    expect(result.stderr).toContain("bun install -g @usepipr/cli@latest");
    expect(result.stderr.startsWith("error: ")).toBe(true);
    expect(result.stderr).toContain("\nIf you installed with npm");
    expect(result.stderr).not.toContain("::error::");
    expect(result.stderr).not.toContain("%0A");
  });

  it("prints and materializes the bundled setup skill", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    try {
      const get = await runCli(["skill"], { PIPR_SKILL_CACHE_DIR: cacheDir });
      const pathResult = await runCli(["skill", "path"], {
        PIPR_SKILL_CACHE_DIR: cacheDir,
      });

      expect(get.exitCode, `${get.stdout}\n${get.stderr}`).toBe(0);
      expect(get.stdout).toContain("BEGIN SKILL FILE: SKILL.md");
      expect(get.stdout).toContain("BEGIN SKILL FILE: references/config-patterns.md");
      expect(get.stdout).toContain("BEGIN SKILL FILE: references/recipes.md");
      expect(get.stdout).toContain("name: pipr-setup");
      expect(get.stdout).toContain("Install and configure Pipr");
      expect(pathResult.exitCode, `${pathResult.stdout}\n${pathResult.stderr}`).toBe(0);
      const skillPath = pathResult.stdout.trim();
      expect(path.basename(skillPath)).toBe("pipr-setup");
      expect(await Bun.file(path.join(skillPath, "SKILL.md")).text()).toContain("name: pipr-setup");
      expect(
        await Bun.file(path.join(skillPath, "references/config-patterns.md")).text(),
      ).toContain("Pipr Config Patterns");
      expect(await Bun.file(path.join(skillPath, "references/recipes.md")).text()).toContain(
        "Pipr Recipe Selection",
      );
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("materializes the bundled setup skill across concurrent path commands", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          runCliAsync(["skill", "path"], { PIPR_SKILL_CACHE_DIR: cacheDir }),
        ),
      );

      for (const result of results) {
        expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      }
      const skillPaths = new Set(results.map((result) => result.stdout.trim()));
      expect(skillPaths.size).toBe(1);
      const [skillPath = ""] = [...skillPaths];
      expect(skillPath).not.toBe("");
      expect(path.basename(skillPath)).toBe("pipr-setup");
      expect(await Bun.file(path.join(skillPath, "SKILL.md")).text()).toContain("name: pipr-setup");
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("replaces stale skill cache files without following symlinks", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    try {
      const staleSkillDir = path.join(cacheDir, cliPackage.version, "pipr-setup");
      const victimPath = path.join(cacheDir, "victim.txt");
      await mkdir(staleSkillDir, { recursive: true });
      await Bun.write(victimPath, "do not overwrite\n");
      await symlink(victimPath, path.join(staleSkillDir, "SKILL.md"));

      const skillPath = await runSkillPath(cacheDir);

      expect(await Bun.file(victimPath).text()).toBe("do not overwrite\n");
      expect((await lstat(path.join(skillPath, "SKILL.md"))).isSymbolicLink()).toBe(false);
      expect(await Bun.file(path.join(skillPath, "SKILL.md")).text()).toContain("name: pipr-setup");
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("replaces stale extra files in the skill cache", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    try {
      const staleSkillDir = await seedCachedSkillFiles(cacheDir);
      await Bun.write(path.join(staleSkillDir, "notes.txt"), "stale\n");

      const skillPath = await runSkillPath(cacheDir);

      expect(await fileExists(path.join(skillPath, "notes.txt"))).toBe(false);
      expect(await Bun.file(path.join(skillPath, "SKILL.md")).text()).toContain("name: pipr-setup");
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("reuses the skill cache when dotfiles are present", async () => {
    const cacheDir = await mkdtemp(path.join(os.tmpdir(), "pipr-skill-cache-"));
    try {
      const staleSkillDir = await seedCachedSkillFiles(cacheDir);
      await Bun.write(path.join(staleSkillDir, ".DS_Store"), "metadata\n");

      const skillPath = await runSkillPath(cacheDir);

      expect(await Bun.file(path.join(skillPath, ".DS_Store")).text()).toBe("metadata\n");
      expect(await Bun.file(path.join(skillPath, "SKILL.md")).text()).toContain("name: pipr-setup");
    } finally {
      await removeWorkspace(cacheDir);
    }
  });

  it("requires exactly one bundled setup skill", () => {
    const skill = bundledSkillFixture("pipr-setup");

    expect(singleBundledSkill({ skills: [skill] })).toBe(skill);
    expect(() => singleBundledSkill({ skills: [] })).toThrow(
      "Expected exactly one bundled skill named 'pipr-setup'",
    );
    expect(() => singleBundledSkill({ skills: [bundledSkillFixture("other")] })).toThrow(
      "Expected exactly one bundled skill named 'pipr-setup'",
    );
    expect(() =>
      singleBundledSkill({ skills: [skill, bundledSkillFixture("another-skill")] }),
    ).toThrow("Expected exactly one bundled skill named 'pipr-setup'");
  });

  it("keeps bundled skill file paths inside the target directory", () => {
    const root = path.resolve(os.tmpdir(), "pipr-skill-root");

    expect(containedSkillFilePath(root, "references/recipes.md")).toBe(
      path.join(root, "references", "recipes.md"),
    );
    expect(() => containedSkillFilePath(root, path.join(root, "SKILL.md"))).toThrow(
      "Bundled skill file path must be relative",
    );
    expect(() => containedSkillFilePath(root, "../escape.md")).toThrow(
      "Bundled skill file path escapes the skill directory",
    );
  });

  it("rejects unexpected files in the bundled setup skill", async () => {
    const skillsRoot = await mkdtemp(path.join(os.tmpdir(), "pipr-skills-root-"));
    try {
      const skillDir = path.join(skillsRoot, "pipr-setup");
      await mkdir(path.join(skillDir, "references"), { recursive: true });
      await Bun.write(path.join(skillDir, "SKILL.md"), "---\ndescription: Test skill\n---\n");
      await Bun.write(path.join(skillDir, "references/config-patterns.md"), "patterns\n");
      await Bun.write(path.join(skillDir, "references/recipes.md"), "recipes\n");
      await Bun.write(path.join(skillDir, "notes.txt"), "internal\n");

      await expect(readBundledSkillCatalog(skillsRoot)).rejects.toThrow(
        "pipr-setup bundled files must match the release allowlist",
      );
    } finally {
      await removeWorkspace(skillsRoot);
    }
  });

  it("requires an explicit base SHA for local review runs", async () => {
    const result = await runCli(["review"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: required option '--base <sha>' not specified");
    expect(result.stderr).not.toContain("::error::");
  });

  it("runs local review without GitHub publishing", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      const result = await runCli(
        ["review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        '# <img src="https://pipr.run/images/pipr/pipr-mark.svg" width="22" height="22" alt=""> Pipr Review',
      );
      expect(result.stdout).toContain("No findings.");
      expect(result.stdout).not.toContain("<!-- pipr:main-comment ");
      expect(result.stderr).toContain("pipr local review start");
      expect(result.stderr).toContain("pipr task runtime start");
      expect(result.stderr).toContain("pipr local review complete");
      expect(result.stderr).not.toContain('{"level":');
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("reviews unstaged working tree changes when local head is omitted", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      await Bun.write(path.join(workspace.rootDir, "src/a.ts"), "export const value = 3;\n");

      const result = await runCli(
        ["review", "--base", workspace.headSha, "--pi-executable", workspace.piExecutable],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("diffTarget=working-tree");
      expect(result.stderr).toContain("pipr diff manifest");
      expect(result.stderr).toContain("files=1");
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("prints local review JSON when requested", async () => {
    const workspace = await createLocalReviewWorkspace({ taskLog: true });
    try {
      const result = await runCli(
        [
          "review",
          "--base",
          workspace.baseSha,
          "--pi-executable",
          workspace.piExecutable,
          "--json",
        ],
        { DEEPSEEK_API_KEY: "provider-key" },
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stderr).toContain("pipr local review start");
      expect(result.stderr).toContain("running local review");
      expect(result.stderr).toContain("pipr local review complete");
      expect(result.stderr).not.toContain('{"level":');
      const json = JSON.parse(result.stdout) as {
        kind: string;
        mainComment: string;
        inlineFindings: unknown[];
        taskChecks: unknown[];
      };
      expect(json.kind).toBe("review");
      expect(json.mainComment).toContain("<!-- pipr:main-comment ");
      expect(json.mainComment).toContain("No findings.");
      expect(json.inlineFindings).toEqual([]);
      expect(json.taskChecks).toEqual([{ taskName: "review", conclusion: "success" }]);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("loads provider env from .env for local review", async () => {
    const workspace = await createLocalReviewWorkspace();
    try {
      await Bun.write(path.join(workspace.rootDir, ".env"), "DEEPSEEK_API_KEY=provider-key\n");

      const result = await runCli(
        ["review", "--base", workspace.baseSha, "--pi-executable", workspace.piExecutable],
        {},
        workspace.rootDir,
      );

      expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(await countLines(path.join(workspace.rootDir, "pi-called"))).toBe(1);
    } finally {
      await removeWorkspace(workspace.rootDir);
    }
  });

  it("initializes and checks the TypeScript config", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await runInitAndCheck(workspace, ["init"]);

      expect(await Bun.file(path.join(workspace, ".pipr", "config.ts")).text()).toContain(
        "pipr.review",
      );
      expect(
        await Bun.file(path.join(workspace, ".github", "workflows", "pipr.yml")).text(),
      ).toContain("uses: somus/pipr@v0.3.3"); // x-release-please-version
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("initializes config files without adapter files", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await runInit(workspace, ["init", "--adapters", "none"]);

      expect(await fileExists(path.join(workspace, ".github", "workflows", "pipr.yml"))).toBe(
        false,
      );
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("initializes a minimal single-file config without package.json", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await runInit(workspace, ["init", "--adapters", "none", "--minimal"]);

      expect(await fileExists(path.join(workspace, ".pipr", "tsconfig.json"))).toBe(false);
      expect(await fileExists(path.join(workspace, ".pipr", "package.json"))).toBe(false);
      expect(await fileExists(path.join(workspace, ".pipr", "config.ts"))).toBe(true);
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("initializes a selected starter recipe", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const init = await runCli(
        ["init", "--adapters", "none", "--recipe", "plugin-tool-review"],
        {},
        workspace,
      );
      const inspect = await runCli(["inspect"], {}, workspace);

      expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
      expect(init.stdout).toMatch(/created \d+ file\(s\)/);
      expect(inspect.exitCode, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
      expect(inspect.stdout).toContain("r2_memory_search");
      expect(await Bun.file(path.join(workspace, ".pipr", "config.ts")).text()).toContain(
        "r2MemoryPlugin",
      );
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("rejects unsupported init adapters", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const unsupported = await runCli(["init", "--adapters", "gitlab"], {}, workspace);
      const mixedNone = await runCli(["init", "--adapters", "none,github"], {}, workspace);
      const unsupportedRecipe = await runCli(
        ["init", "--adapters", "none", "--recipe", "missing"],
        {},
        workspace,
      );

      expect(unsupported.exitCode).toBe(1);
      expect(`${unsupported.stdout}\n${unsupported.stderr}`).toContain(
        "Unsupported pipr init adapter 'gitlab'. Supported adapters: github",
      );
      expect(`${unsupported.stdout}\n${unsupported.stderr}`).not.toContain("::error::");
      expect(mixedNone.exitCode).toBe(1);
      expect(`${mixedNone.stdout}\n${mixedNone.stderr}`).toContain(
        "Adapter 'none' cannot be mixed with other init adapters",
      );
      expect(`${mixedNone.stdout}\n${mixedNone.stderr}`).not.toContain("::error::");
      expect(unsupportedRecipe.exitCode).toBe(1);
      expect(`${unsupportedRecipe.stdout}\n${unsupportedRecipe.stderr}`).toContain(
        "Unsupported pipr init recipe 'missing'. Supported recipes:",
      );
      expect(`${unsupportedRecipe.stdout}\n${unsupportedRecipe.stderr}`).not.toContain("::error::");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("prints friendly missing config errors for local config commands outside a Pipr project", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const eventPath = path.join(workspace, "event.json");
      await Bun.write(eventPath, "{}");
      const resolvedWorkspace = await realpath(workspace);
      const missingConfigMessage = `error: No Pipr config found at ${path.join(
        resolvedWorkspace,
        ".pipr",
        "config.ts",
      )}.`;

      for (const args of [
        ["check"],
        ["inspect"],
        ["dry-run", "--event", eventPath],
        ["review", "--base", "HEAD"],
      ]) {
        const result = await runCli(args, {}, workspace);

        expect(result.exitCode, args.join(" ")).toBe(1);
        expect(result.stdout, args.join(" ")).toBe("");
        expect(result.stderr, args.join(" ")).toContain(missingConfigMessage);
        expect(result.stderr, args.join(" ")).toContain(
          "Run `pipr init` to create one, or pass `--config-dir <dir>`.",
        );
        expect(result.stderr, args.join(" ")).not.toContain("::error::");
        expect(result.stderr, args.join(" ")).not.toContain("%0A");
        expect(result.stderr, args.join(" ")).not.toContain("Cannot find global type");
      }
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("strips terminal control sequences from local fatal errors", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await mkdir(path.join(workspace, ".pipr"));
      await Bun.write(
        path.join(workspace, ".pipr", "config.ts"),
        'throw new Error("bad \\u001b]0;evil\\u0007\\nnext \\u001b[31mred\\u001b[0m\\rline");\n',
      );

      const result = await runCli(["check"], {}, workspace);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("error: bad \nnext redline");
      expect(result.stderr).not.toContain("\u001b");
      expect(result.stderr).not.toContain("\u0007");
      expect(result.stderr).not.toContain("\r");
      expect(result.stderr).not.toContain("::error::");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("keeps GitHub Actions error formatting for action runs", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      const result = await runCli(["check"], { GITHUB_ACTIONS: "true" }, workspace);
      const review = await runCli(["review"], { GITHUB_ACTIONS: "true" }, workspace);
      const version = await runCli(["--version"], { GITHUB_ACTIONS: "true" }, workspace);

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toContain("::error::");
      expect(review.exitCode).toBe(1);
      expect(`${review.stdout}\n${review.stderr}`).toContain("::error::");
      expect(`${review.stdout}\n${review.stderr}`).toContain(
        "required option '--base <sha>' not specified",
      );
      expect(version.exitCode).toBe(0);
      expect(version.stdout.trim()).toBe(cliPackage.version);
      expect(`${version.stdout}\n${version.stderr}`).not.toContain("::error::");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("checks the repo root dogfood config", async () => {
    const result = await runCli(["check"], {}, repoRoot);

    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("valid:");
    expect(result.stdout).toContain(".pipr/config.ts");
    expect(await listFiles(path.join(repoRoot, ".pipr"))).toContain("config.ts");
  });

  it("refuses init conflicts unless force is explicit", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await mkdir(path.join(workspace, ".pipr"));
      await Bun.write(path.join(workspace, ".pipr", "config.ts"), "custom: true\n");

      const conflict = await runCli(["init"], {}, workspace);
      const forced = await runCli(["init", "--force"], {}, workspace);

      expect(conflict.exitCode).toBe(1);
      expect(`${conflict.stdout}\n${conflict.stderr}`).toContain(
        "Use --force to replace existing .pipr files",
      );
      expect(forced.exitCode).toBe(0);
      expect(forced.stdout).toContain("overwrote 1");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("runs action dry-run without requiring provider env", async () => {
    const result = await runActionWithGitWorkspace({
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("::group::pipr action");
    expect(result.stdout).toContain('::notice::{"level":"notice"');
    expect(result.stdout).toContain('"event":"action start"');
    expect(result.stdout).toContain("pipr loaded change #1 for local/pipr");
    expect(result.stdout).toContain("PIPR_DRY_RUN=1");
    expect(result.piCalled).toBe(false);
  });

  it("fails action dry-run before model work when config is missing", async () => {
    const result = await runActionWithGitWorkspace({
      initConfig: false,
      env: { PIPR_DRY_RUN: "1" },
    });

    expect(result.exitCode).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      "No Pipr config found at .pipr/config.ts in base commit",
    );
    expect(result.piCalled).toBe(false);
  });

  it("inspects the TS runtime plan after config validation", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await initWorkspaceConfig(workspace);
      const inspect = await runCli(["inspect"], {}, workspace);

      expect(inspect.exitCode).toBe(0);
      expect(inspect.stdout).toContain("models");
      expect(inspect.stdout).toContain("agents");
      expect(inspect.stdout).toContain("tasks");
      expect(inspect.stdout).toContain("events");
      expect(inspect.stdout).toContain("commands");
      expect(inspect.stdout).not.toContain("locals");
      expect(inspect.stdout).toContain("tools");
      expect(inspect.stdout).toContain("schemas");
      expect(inspect.stdout).toContain("core/pr-review");
      expect(inspect.stdout).toContain("core/summary");
      expect(inspect.stdout).not.toContain("core/review-candidates");
      expect(inspect.stdout).not.toContain("core/consolidated-review");
      expect(inspect.stdout).toContain("deepseek");
      expect(inspect.stdout).toContain("@pipr review");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("prints config version warnings for check, inspect, and dry-run", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await initWorkspaceConfig(workspace);
      await writeSdkDependency(workspace, "0.1.0");
      const eventPath = path.join(workspace, "event.json");
      await Bun.write(eventPath, JSON.stringify(pullRequestPayload()));

      const check = await runCli(["check"], {}, workspace);
      const inspect = await runCli(["inspect"], {}, workspace);
      const dryRun = await runCli(["dry-run", "--event", eventPath], {}, workspace);
      const warning =
        `.pipr/package.json pins @usepipr/sdk 0.1.0, but this Pipr runtime is ${cliPackage.version}. ` +
        "Run `pipr init --force` or update .pipr/package.json and .pipr/bun.lock when ready.";

      expect(check.exitCode, `${check.stdout}\n${check.stderr}`).toBe(0);
      expect(check.stdout).toContain(`warning: ${warning}`);
      expect(inspect.exitCode, `${inspect.stdout}\n${inspect.stderr}`).toBe(0);
      expect(inspect.stdout).toContain(`warning: ${warning}`);
      expect(dryRun.exitCode, `${dryRun.stdout}\n${dryRun.stderr}`).toBe(0);
      expect(dryRun.stdout).toContain(`warning: ${warning}`);
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("fails check before config execution when the config SDK pin is newer than Pipr", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
    try {
      await initWorkspaceConfig(workspace);
      await writeSdkDependency(workspace, "999.0.0");

      const check = await runCli(["check"], {}, workspace);

      expect(check.exitCode).toBe(1);
      expect(check.stderr).toContain(
        `.pipr/package.json pins @usepipr/sdk 999.0.0, but this Pipr runtime is ${cliPackage.version}. Upgrade Pipr before running this config.`,
      );
      expect(check.stderr).not.toContain("::error::");
      expect(check.stderr).not.toContain("%0A");
    } finally {
      await removeWorkspace(workspace);
    }
  });

  it("embeds standalone SDK declarations for release init", async () => {
    const declaration = embeddedSdkDeclaration(await readSdkDeclarationModules(repoRoot));

    expect(declaration).toContain('declare module "@usepipr/sdk"');
    expect(declaration).toContain("const z: {");
    expect(declaration).toContain("type ZodSchema<T>");
    expect(declaration).not.toContain('from "zod"');
    expect(declaration).not.toContain("z.ZodType");
  });
});

async function runActionWithGitWorkspace(options: {
  env?: NodeJS.ProcessEnv;
  initConfig?: boolean;
}): Promise<{
  exitCode: number;
  baseSha: string;
  headSha: string;
  piCalled: boolean;
  piCallCount: number;
  stdout: string;
  stderr: string;
}> {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  try {
    await runCommand("git", ["init", "--initial-branch=main"], workspace);
    await runCommand("git", ["config", "user.name", "pipr test"], workspace);
    await runCommand("git", ["config", "user.email", "pipr@example.test"], workspace);
    await runCommand("git", ["config", "core.hooksPath", "/dev/null"], workspace);
    await runCommand("git", ["config", "commit.gpgsign", "false"], workspace);
    if (options.initConfig !== false) {
      await initWorkspaceConfig(workspace);
    }
    await mkdir(path.join(workspace, "src"));
    await Bun.write(path.join(workspace, "src/a.ts"), "export const value = 1;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "base"], workspace);
    const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    await Bun.write(path.join(workspace, "src/a.ts"), "export const value = 2;\n");
    await runCommand("git", ["add", "."], workspace);
    await runCommand("git", ["commit", "--no-verify", "-m", "head"], workspace);
    const headSha = (await runCommand("git", ["rev-parse", "HEAD"], workspace)).trim();
    const eventPath = path.join(workspace, "event.json");
    const githubOutputPath = path.join(workspace, "github-output.txt");
    await Bun.write(eventPath, JSON.stringify(pullRequestPayload(baseSha, headSha)));
    await Bun.write(githubOutputPath, "");

    const result = await runCli(["action"], {
      DEEPSEEK_API_KEY: "provider-key",
      ...options.env,
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_OUTPUT: githubOutputPath,
      GITHUB_WORKSPACE: workspace,
    });
    return {
      ...result,
      baseSha,
      headSha,
      piCalled: await fileExists(path.join(workspace, "pi-called")),
      piCallCount: await countLines(path.join(workspace, "pi-called")),
    };
  } finally {
    await removeWorkspace(workspace);
  }
}

async function createLocalReviewWorkspace(options: { taskLog?: boolean } = {}): Promise<{
  rootDir: string;
  baseSha: string;
  headSha: string;
  piExecutable: string;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-cli-"));
  await runCommand("git", ["init", "--initial-branch=main"], rootDir);
  await runCommand("git", ["config", "user.name", "pipr test"], rootDir);
  await runCommand("git", ["config", "user.email", "pipr@example.test"], rootDir);
  await runCommand("git", ["config", "core.hooksPath", "/dev/null"], rootDir);
  await runCommand("git", ["config", "commit.gpgsign", "false"], rootDir);
  await initWorkspaceConfig(rootDir);
  if (options.taskLog) {
    await Bun.write(path.join(rootDir, ".pipr", "config.ts"), localReviewConfigWithTaskLog());
  }
  await mkdir(path.join(rootDir, "src"));
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 1;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "base"], rootDir);
  const baseSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  await Bun.write(path.join(rootDir, "src/a.ts"), "export const value = 2;\n");
  await runCommand("git", ["add", "."], rootDir);
  await runCommand("git", ["commit", "--no-verify", "-m", "head"], rootDir);
  const headSha = (await runCommand("git", ["rev-parse", "HEAD"], rootDir)).trim();
  const piExecutable = path.join(rootDir, "fake-pi.sh");
  await Bun.write(
    piExecutable,
    ["#!/bin/sh", 'printf "1\\n" >> "$(dirname "$0")/pi-called"', noFindingsJsonCommand()].join(
      "\n",
    ),
  );
  await chmod(piExecutable, 0o755);
  return { rootDir, baseSha, headSha, piExecutable };
}

function localReviewConfigWithTaskLog(): string {
  return [
    'import { definePipr } from "@usepipr/sdk";',
    "",
    "export default definePipr((pipr) => {",
    "  const model = pipr.model({",
    '    provider: "deepseek",',
    '    model: "deepseek-v4-pro",',
    '    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),',
    "  });",
    "  const reviewer = pipr.agent({",
    '    name: "reviewer",',
    "    model,",
    '    instructions: "Review this change.",',
    "    output: pipr.schemas.review,",
    '    prompt: () => "Review.",',
    "  });",
    "  const task = pipr.task({",
    '    name: "review",',
    "    async run(ctx) {",
    '      ctx.log.info("running local review");',
    "      const manifest = await ctx.change.diffManifest({ compressed: true });",
    "      const result = await ctx.pi.run(reviewer, { manifest });",
    "      await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });",
    "    },",
    "  });",
    '  pipr.on.changeRequest({ actions: ["opened", "updated"], task });',
    "});",
  ].join("\n");
}

function noFindingsJsonCommand(): string {
  return 'printf \'%s\\n\' \'{"summary":{"body":"No findings."},"inlineFindings":[]}\'';
}

async function countLines(filePath: string): Promise<number> {
  if (!(await fileExists(filePath))) {
    return 0;
  }
  return (await Bun.file(filePath).text()).split("\n").filter(Boolean).length;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function initWorkspaceConfig(workspace: string): Promise<void> {
  const result = await runCli(["init"], {}, workspace);
  if (result.exitCode !== 0) {
    throw new Error(`pipr init failed: ${result.stderr || result.stdout}`);
  }
}

async function writeSdkDependency(workspace: string, version: string): Promise<void> {
  const packageJsonPath = path.join(workspace, ".pipr", "package.json");
  const manifest = (await Bun.file(packageJsonPath).json()) as {
    dependencies?: Record<string, string>;
  };
  await Bun.write(
    packageJsonPath,
    `${JSON.stringify(
      {
        ...manifest,
        dependencies: {
          ...manifest.dependencies,
          "@usepipr/sdk": version,
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function runInitAndCheck(
  workspace: string,
  initArgs: string[],
): Promise<{
  init: Awaited<ReturnType<typeof runCli>>;
  check: Awaited<ReturnType<typeof runCli>>;
}> {
  const init = await runInit(workspace, initArgs);
  const check = await runCli(["check"], {}, workspace);
  expect(check.exitCode, `${check.stdout}\n${check.stderr}`).toBe(0);
  expect(check.stdout).toContain("valid:");
  return { init, check };
}

async function runInit(
  workspace: string,
  initArgs: string[],
): Promise<Awaited<ReturnType<typeof runCli>>> {
  const init = await runCli(initArgs, {}, workspace);
  expect(init.exitCode, `${init.stdout}\n${init.stderr}`).toBe(0);
  expect(init.stdout).toMatch(/created \d+ file\(s\)/);
  return init;
}

async function removeWorkspace(workspace: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(workspace, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt === 19) {
        throw error;
      }
      await delay(100);
    }
  }
}

async function runCli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = Bun.spawnSync(["bun", cliPath, ...args], {
    cwd,
    env: {
      ...minimalEnv(),
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
  };
}

async function runCliAsync(
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd = process.cwd(),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = Bun.spawn(["bun", cliPath, ...args], {
    cwd,
    env: {
      ...minimalEnv(),
      ...env,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    result.exited,
    result.stdout ? new Response(result.stdout).text() : "",
    result.stderr ? new Response(result.stderr).text() : "",
  ]);
  return { exitCode, stdout, stderr };
}

async function runSkillPath(cacheDir: string): Promise<string> {
  const result = await runCli(["skill", "path"], {
    PIPR_SKILL_CACHE_DIR: cacheDir,
  });

  expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

async function seedCachedSkillFiles(cacheDir: string): Promise<string> {
  const skill = singleBundledSkill(await readBundledSkillCatalog(path.join(repoRoot, "skills")));
  const staleSkillDir = path.join(cacheDir, cliPackage.version, "pipr-setup");
  for (const file of skill.files) {
    const target = path.join(staleSkillDir, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await Bun.write(target, file.contents);
  }
  return staleSkillDir;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "BUN_INSTALL",
    "BUN_INSTALL_CACHE_DIR",
    "HOME",
    "LANG",
    "PATH",
    "TMPDIR",
    "USER",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.BUN_INSTALL_CACHE_DIR ??= path.join(repoRoot, "node_modules", ".cache", "pipr-bun-install");
  env.PIPR_INTERNAL_INIT_SDK_VERSION = `file:${path.join(repoRoot, "packages/sdk")}`;
  env.PIPR_UPDATE_NOTICE = "0";
  return env;
}

function bundledSkillFixture(name: string): BundledSkill {
  return {
    name,
    description: "Test skill",
    files: [{ path: "SKILL.md", contents: "---\ndescription: Test skill\n---\n" }],
  };
}

async function runCommand(command: string, args: string[], cwd: string): Promise<string> {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: minimalEnv(),
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout?.toString() ?? "";
  const stderr = result.stderr?.toString() ?? "";
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return stdout;
}

function pullRequestPayload(baseSha = "base", headSha = "head"): unknown {
  return {
    action: "opened",
    number: 1,
    repository: {
      full_name: "local/pipr",
    },
    pull_request: {
      number: 1,
      base: {
        sha: baseSha,
        repo: {
          full_name: "local/pipr",
        },
      },
      head: {
        sha: headSha,
      },
    },
  };
}

function fakeLatestReleaseFetch(version: string, requests: string[] = []): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://api.github.com/repos/somus/pipr/releases/latest") {
      return Response.json({ tag_name: `v${version}` });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(rootDir, prefix), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      if (entry.isDirectory()) {
        return await listFiles(rootDir, relativePath);
      }
      return [relativePath.split(path.sep).join("/")];
    }),
  );
  return files.flat().sort();
}
