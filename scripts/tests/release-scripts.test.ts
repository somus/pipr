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
import typeScriptPackage from "typescript/package.json" with { type: "json" };
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

type Workflow = {
  on: {
    schedule?: Array<{ cron: string }>;
    workflow_dispatch?: unknown;
  };
  jobs: Record<
    string,
    {
      if?: string;
      needs?: string | string[];
      steps?: Array<{
        "continue-on-error"?: boolean;
        env?: Record<string, string>;
        id?: string;
        if?: string;
        name?: string;
        run?: string;
        uses?: string;
        with?: Record<string, unknown>;
      }>;
      strategy?: { matrix?: { include?: Array<{ name?: string }> } };
    }
  >;
};

type ChangedScope = "docs" | "docs-browser" | "docs-container" | "docker" | "prompt";

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

  it("rejects release-triggering titles for dogfood-only changes", () => {
    const repository = changedScopeRepository(".pipr/config.ts");
    const base = git(repository, "rev-parse", "HEAD~1");

    expect(
      runScript(
        path.join(repoRoot, "scripts/check-conventional-commit.ts"),
        ["--title", "fix(config): tune dogfood review", "--range", `${base}..HEAD`],
        repository,
      ),
    ).not.toBe(0);
  });

  it("accepts chore titles for dogfood-only changes", () => {
    const repository = changedScopeRepository(".pipr/config.ts");
    const base = git(repository, "rev-parse", "HEAD~1");

    expect(
      runScript(
        path.join(repoRoot, "scripts/check-conventional-commit.ts"),
        ["--title", "chore(dogfood): tune review", "--range", `${base}..HEAD`],
        repository,
      ),
    ).toBe(0);
  });

  it("accepts release-triggering titles when product files change", () => {
    const repository = changedScopeRepository("packages/runtime/src/index.ts");
    const base = git(repository, "rev-parse", "HEAD~1");

    expect(
      runScript(
        path.join(repoRoot, "scripts/check-conventional-commit.ts"),
        ["--title", "fix(runtime): tune review", "--range", `${base}..HEAD`],
        repository,
      ),
    ).toBe(0);
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
  it("includes bundled skills in the CLI build cache inputs", () => {
    const config = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/cli/turbo.json"), "utf8"),
    ) as { extends?: string[]; tasks?: { build?: { inputs?: string[] } } };

    expect(config.extends).toEqual(["//"]);
    expect(config.tasks?.build?.inputs).toContain("$TURBO_DEFAULT$");
    expect(config.tasks?.build?.inputs).toContain("$TURBO_ROOT$/skills/**");
  });

  it("routes expensive lanes through table-driven owning paths", () => {
    const cases: Array<{
      scope: ChangedScope;
      positive: string;
      dependency: string;
      negative: string;
    }> = [
      {
        scope: "docs",
        positive: "apps/docs/content/docs/guide/quickstart.mdx",
        dependency: "packages/runtime/src/config/recipes/default-review.ts",
        negative: "packages/runtime/src/review/comment.ts",
      },
      {
        scope: "docs-browser",
        positive: "apps/docs/src/router.tsx",
        dependency: "apps/docs/vite.config.ts",
        negative: "apps/docs/content/docs/guide/quickstart.mdx",
      },
      {
        scope: "docs-container",
        positive: "apps/docs/nginx.conf",
        dependency: "bun.lock",
        negative: "apps/docs/src/router.tsx",
      },
      {
        scope: "docker",
        positive: "packages/runtime/src/host-run/commands.ts",
        dependency: "packages/e2e/action-fixture.ts",
        negative: "packages/runtime/src/review/comment.ts",
      },
      {
        scope: "prompt",
        positive: "packages/evals/src/deterministic-smoke.ts",
        dependency: "packages/runtime/src/review/contract.ts",
        negative: "packages/runtime/src/hosts/github/event.ts",
      },
    ];

    for (const { scope, positive, dependency, negative } of cases) {
      expect(scopeChanged(scope, positive), `${scope}: ${positive}`).toBe(true);
      expect(scopeChanged(scope, dependency), `${scope}: ${dependency}`).toBe(true);
      expect(scopeChanged(scope, negative), `${scope}: ${negative}`).toBe(false);
    }
  }, 30000);

  it("keeps fixture tests and Pi CLI owners in the Docker Action lane", () => {
    for (const file of [
      "packages/e2e/assertions.test.ts",
      "packages/runtime/src/pi/contract.ts",
      "packages/runtime/src/pi/provider.ts",
      "packages/runtime/src/pi/runner.ts",
    ]) {
      expect(scopeChanged("docker", file), file).toBe(true);
    }
  });

  it("runs every expensive scope when the scope router changes", () => {
    const scopes: ChangedScope[] = ["docs", "docs-browser", "docs-container", "docker", "prompt"];
    for (const scope of scopes) {
      expect(scopeChanged(scope, "scripts/changed-scope.ts"), scope).toBe(true);
    }
  });

  it("routes canonical prompt and browser build owners to their lanes", () => {
    expect(scopeChanged("prompt", "packages/runtime/src/pi/runner.ts")).toBe(true);
    expect(scopeChanged("docs-browser", "apps/docs/scripts/og-images.ts")).toBe(true);
  });

  it("keeps the source owner visible when an exact-match path is renamed", () => {
    const repository = changedScopeRepository("packages/runtime/src/pi/runner.ts");
    const base = git(repository, "rev-parse", "HEAD");
    run("git", ["mv", "packages/runtime/src/pi/runner.ts", "renamed-runner.ts"], {
      cwd: repository,
    });
    run("git", ["commit", "-m", "refactor: move runner"], { cwd: repository });
    const head = git(repository, "rev-parse", "HEAD");

    for (const scope of ["docker", "prompt"] satisfies ChangedScope[]) {
      const result = changedScopeResult(scope, repository, {
        EVENT_NAME: "pull_request",
        PR_BASE_SHA: base,
        PR_HEAD_SHA: head,
      });
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(result.stdout.trim(), scope).toBe("changed=true");
    }
  });

  it("fails open for every scope when PR history is unavailable", () => {
    const scopes: ChangedScope[] = ["docs", "docs-browser", "docs-container", "docker", "prompt"];
    const repository = changedScopeRepository("README.md");
    const head = git(repository, "rev-parse", "HEAD");

    for (const scope of scopes) {
      const result = changedScopeResult(scope, repository, {
        EVENT_NAME: "pull_request",
        PR_BASE_SHA: "f".repeat(40),
        PR_HEAD_SHA: head,
      });
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("changed=true");
    }
  });

  it("runs every expensive scope on main pushes", () => {
    const scopes: ChangedScope[] = ["docs", "docs-browser", "docs-container", "docker", "prompt"];
    const repository = changedScopeRepository("README.md");

    for (const scope of scopes) {
      const result = changedScopeResult(scope, repository, { EVENT_NAME: "push" });
      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
      expect(result.stdout.trim()).toBe("changed=true");
    }
  });
});

describe("developer checks", () => {
  it("selects only root script tests", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(rootPackageJson.scripts?.["check:scripts:root"]).toBe(
      "bun test ./scripts/tests/*.test.ts",
    );
  });

  it("uses TypeScript 7 directly while keeping the TypeScript 6 API scoped to embedded tools", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      catalog?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const runtimePackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/runtime/package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; scripts?: Record<string, string> };
    const docsPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "apps/docs/package.json"), "utf8"),
    ) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    const runtimeBuildTsconfig = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/runtime/tsconfig.build.json"), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    const cliPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/cli/package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const cliBuildTsconfig = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/cli/tsconfig.build.json"), "utf8"),
    ) as { compilerOptions?: { paths?: Record<string, string[]> } };
    const typecheckCommand = "tsc --noEmit";
    const typecheckScripts = [
      ["package.json", "typecheck:root"],
      ["packages/cli/package.json", "typecheck"],
      ["packages/e2e/package.json", "typecheck"],
      ["packages/evals/package.json", "typecheck"],
      ["packages/sdk/package.json", "typecheck"],
    ] as const;

    expect(rootPackageJson.catalog?.typescript).toBe("7.0.2");
    expect(rootPackageJson.devDependencies?.["@typescript/native"]).toBeUndefined();
    expect(rootPackageJson.devDependencies?.typescript6).toBe("npm:typescript@6.0.3");
    expect(typeScriptPackage.version).toBe("7.0.2");
    expect(runtimePackageJson.dependencies?.typescript6).toBe("npm:typescript@6.0.3");
    expect(runtimePackageJson.dependencies?.typescript).toBeUndefined();
    expect(docsPackageJson.devDependencies?.typescript).toBe("6.0.3");
    expect(docsPackageJson.scripts?.["typecheck:generated"]).toBe(
      "bun ../../node_modules/typescript/bin/tsc --noEmit",
    );
    expect(runtimePackageJson.scripts?.typecheck).toBe(
      "bun ../../node_modules/typescript/bin/tsc --noEmit",
    );
    expect(runtimePackageJson.scripts?.build).toContain("--tsconfig tsconfig.build.json");
    expect(runtimeBuildTsconfig.compilerOptions?.paths).toEqual({});
    expect(cliPackageJson.scripts?.build).toContain("--tsconfig tsconfig.build.json");
    expect(cliBuildTsconfig.compilerOptions?.paths).toEqual({});
    for (const [packagePath, script] of typecheckScripts) {
      const packageJson = JSON.parse(readFileSync(path.join(repoRoot, packagePath), "utf8")) as {
        scripts?: Record<string, string>;
      };
      expect(packageJson.scripts?.[script]).toBe(typecheckCommand);
    }

    const version = Bun.spawnSync(["bun", "run", "tsc", "--version"], { cwd: repoRoot });
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toBe("Version 7.0.2");
  });

  it("serializes docs type generation through the Turbo graph", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };
    const packageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "apps/docs/package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const turbo = JSON.parse(readFileSync(path.join(repoRoot, "apps/docs/turbo.json"), "utf8")) as {
      tasks?: Record<string, { dependsOn?: string[] }>;
    };

    expect(packageJson.scripts?.build).toContain("typegen");
    expect(packageJson.scripts?.typecheck).toContain("typegen");
    expect(packageJson.scripts?.test).toContain("typegen");
    expect(rootPackageJson.scripts?.["check:docs"]).toContain("build:generated");
    expect(rootPackageJson.scripts?.["check:docs"]).toContain("typecheck:generated");
    expect(rootPackageJson.scripts?.["check:docs"]).toContain("test:generated");
    expect(turbo.tasks?.["build:generated"]?.dependsOn).toContain("typegen");
    expect(turbo.tasks?.["typecheck:generated"]?.dependsOn).toContain("typegen");
    expect(turbo.tasks?.["test:generated"]?.dependsOn).toContain("typegen");
  });

  it("installs the docs browser with the pinned workspace Playwright", () => {
    const workflow = parseWorkflow(".github/workflows/ci.yml");
    const installStep = workflow.jobs["docs-browser"]?.steps?.find((step) =>
      step.run?.includes("playwright install"),
    );

    expect(installStep?.run).toBe(
      "bun run --cwd apps/docs playwright install --with-deps chromium",
    );
  });

  it("routes PR packages through one affected graph and keeps main complete", () => {
    const workflow = parseWorkflow(".github/workflows/ci.yml");
    const packages = workflow.jobs.packages;
    const commands = packages?.steps?.filter((step) => step.run?.includes("turbo run")) ?? [];
    const checkout = packages?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));

    expect(packages?.strategy).toBeUndefined();
    expect(checkout?.with?.ref).toBeUndefined();
    expect(commands).toHaveLength(2);
    expect(commands.find((step) => step.if?.includes("pull_request"))?.run).toContain("--affected");
    const mainCommand = commands.find((step) => step.if?.includes("push"))?.run;
    expect(mainCommand).toContain("build lint typecheck test format:check");
    expect(mainCommand).not.toContain("--affected");
    expect(commands.find((step) => step.if?.includes("pull_request"))?.env).toMatchObject({
      TURBO_SCM_BASE: "${{ github.event.pull_request.base.sha }}",
      TURBO_SCM_HEAD: "${{ github.event.pull_request.head.sha }}",
    });
  });

  it("aggregates every CI lane in the stable final check", () => {
    const workflow = parseWorkflow(".github/workflows/ci.yml");
    const expectedNeeds = [
      "conventional-commits",
      "changes",
      "packages",
      "package-quality",
      "fallow-audit",
      "docs",
      "docs-browser",
      "docs-container",
      "docker-e2e",
      "prompt-smoke",
    ];
    const needs = workflow.jobs.check?.needs;
    expect(needs).toEqual(expectedNeeds);
    const aggregate = workflow.jobs.check?.steps?.find((step) => step.run?.includes("for result"));
    for (const job of expectedNeeds) {
      expect(aggregate?.run).toContain(`needs.${job}.result`);
    }
  });

  it("keeps package checks and deterministic prompt smoke graph-owned", () => {
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const evalPackage = JSON.parse(
      readFileSync(path.join(repoRoot, "packages/evals/package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };
    const workflow = parseWorkflow(".github/workflows/ci.yml");
    const promptCommands = workflow.jobs["prompt-smoke"]?.steps
      ?.map((step) => step.run)
      .filter((run): run is string => Boolean(run));

    expect(rootPackage.scripts?.["check:packages"]).toStartWith("turbo run build lint typecheck");
    expect(rootPackage.scripts?.["check:packages"]).not.toContain("build:packages &&");
    expect(rootPackage.scripts?.["check:packages"]).not.toContain("check:runtime-test-split");
    expect(evalPackage.scripts?.["eval:deterministic:run"]).toBe(
      "bun ./src/deterministic-smoke.ts",
    );
    expect(existsSync(path.join(repoRoot, "packages/e2e/prompt-evals.test.ts"))).toBe(false);
    expect(promptCommands).toContain("bunx turbo run build --filter=@usepipr/runtime");
    expect(promptCommands).toContain("bun run --cwd packages/evals eval:deterministic:run");
  });

  it("marks root package configuration as a global Turbo dependency", () => {
    const turbo = JSON.parse(readFileSync(path.join(repoRoot, "turbo.json"), "utf8")) as {
      globalDependencies?: string[];
    };
    expect(turbo.globalDependencies).toContain("mise.toml");
    expect(turbo.globalDependencies).toContain("tsconfig.base.json");
    expect(turbo.globalDependencies).toContain("tsconfig.json");
  });

  it("runs the full release check only for manual dispatch", () => {
    const workflow = parseWorkflow(".github/workflows/release.yml");
    const fullCheck = workflow.jobs.publish?.steps?.find((step) => step.run === "bun run check");
    expect(fullCheck?.if).toBe("github.event_name == 'workflow_dispatch'");
  });

  it("runs the Fallow 3 audit gate locally and against the explicit CI base", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as {
      scripts?: Record<string, string>;
    };
    const workflow = parseWorkflow(".github/workflows/ci.yml");
    const audit = workflow.jobs["fallow-audit"];
    const auditStep = audit?.steps?.find((step) => step.run === "bun run fallow:audit");
    const checkout = audit?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));

    expect(rootPackageJson.scripts?.["fallow:audit"]).toBe("fallow audit --format compact");
    expect(rootPackageJson.scripts?.fallow).toContain("fallow:audit");
    expect(rootPackageJson.scripts?.check).toContain("fallow:audit");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
    expect(auditStep?.env?.FALLOW_AUDIT_BASE).toContain("github.event.pull_request.base.sha");
    expect(auditStep?.env?.FALLOW_AUDIT_BASE).toContain("github.event.before");
    expect(workflow.jobs.check?.needs).toContain("fallow-audit");
  });

  it("runs scheduled live evals in an advisory container lane", () => {
    const workflow = parseWorkflow(".github/workflows/evals.yml");
    const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");
    expect(workflow.on.schedule).toEqual([{ cron: "17 3 * * 1" }]);
    expect(workflow.on).toHaveProperty("workflow_dispatch");
    const advisory = workflow.jobs.advisory;
    expect(advisory).toBeDefined();
    expect(advisory?.steps?.some((step) => step["continue-on-error"] === true)).toBe(true);
    expect(advisory?.steps?.some((step) => step.run?.includes("--target evals"))).toBe(true);
    expect(dockerfile).toContain("FROM build AS evals");
    expect(dockerfile).toContain('CMD ["bun", "run", "eval:full:export"]');
  });
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
      "image: ${PIPR_IMAGE:-ghcr.io/somus/pipr:v0.1.1}",
    );
    expect(readFileSync(path.join(repository, "deploy/webhook/.env.example"), "utf8")).toContain(
      "PIPR_IMAGE=ghcr.io/somus/pipr:v0.1.1",
    );
    expect(readFileSync(path.join(repository, ".github/workflows/pipr.yml"), "utf8")).toContain(
      `uses: somus/pipr@v${dogfoodSdkVersion}`,
    );
    const initProjectTests = readFileSync(
      path.join(repository, "packages/runtime/src/config/tests/init-project.test.ts"),
      "utf8",
    );
    expect(initProjectTests).toContain("uses: somus/pipr@v0.1.1");
    expect(initProjectTests).toContain("ghcr.io/somus/pipr:v0.1.1");
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

    const configWorkspace = path.join(tempDir, "standalone-sdk-config");
    writeCreatingDirs(
      path.join(configWorkspace, ".pipr/config.ts"),
      `import {
  defaultReviewActions,
  defaultReviewEntrypoints,
  definePipr,
} from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });
  pipr.review({
    id: "review",
    model,
    entrypoints: {
      ...defaultReviewEntrypoints,
      changeRequest: defaultReviewActions,
    },
    instructions: {
      findings: "Review the change.",
      summary: "Summarize the change.",
    },
  });
});
`,
    );
    const standaloneCheck = executableResult(binaryPath, ["check"], configWorkspace, {
      PIPR_UPDATE_NOTICE: "0",
    });
    expect(standaloneCheck.exitCode, `${standaloneCheck.stdout}\n${standaloneCheck.stderr}`).toBe(
      0,
    );
  }, 30000);

  it("keeps updater asset names aligned with release targets", () => {
    const releaseAssetNames = releaseTargets
      .map((target) => releaseAssetForPlatform(target))
      .sort();
    expect(releaseAssetNames).toEqual(releaseTargets.map((target) => target.outfile).sort());
    expect(new Set(releaseAssetNames).size).toBe(releaseTargets.length);
  });

  it("accepts only the exact checksummed release artifact set", () => {
    const releaseDir = path.join(tempDir, "release-artifacts");
    mkdirSync(releaseDir);
    const lines = releaseTargets.map(({ outfile }, index) => {
      const contents = `binary-${index}\n`;
      write(path.join(releaseDir, outfile), contents);
      return `${createHash("sha256").update(contents).digest("hex")}  ${outfile}`;
    });
    write(path.join(releaseDir, "SHA256SUMS"), `${lines.sort().join("\n")}\n`);

    expect(runScript("scripts/verify-release-artifacts.ts", [releaseDir])).toBe(0);

    write(path.join(releaseDir, "SHA256SUMS"), `${"0".repeat(64)}  ${releaseTargets[0].outfile}\n`);
    expect(runScript("scripts/verify-release-artifacts.ts", [releaseDir])).not.toBe(0);

    write(path.join(releaseDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
    write(path.join(releaseDir, "pipr-stale"), "stale\n");
    expect(runScript("scripts/verify-release-artifacts.ts", [releaseDir])).not.toBe(0);
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
    ).toContain("Pipr recipe selection");
  }, 30000);
});

describe("install.sh", () => {
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
  it("rejects documentation release markers that drift from the root version", () => {
    const repository = copyRepositoryFixture();
    const quickstartPath = path.join(repository, "apps/docs/content/docs/guide/quickstart.mdx");
    write(
      quickstartPath,
      `${readFileSync(quickstartPath, "utf8")}\nRelease v0.0.0. {/* x-release-please-version */}\n`,
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects documentation that claims publishing runs from release.published", () => {
    const repository = copyRepositoryFixture();
    const documentationPath = path.join(repository, "apps/docs/content/docs/guide/quickstart.mdx");
    write(
      documentationPath,
      `${readFileSync(documentationPath, "utf8")}\nPublishing runs directly from release.published.\n`,
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects missing Release Please extra files", () => {
    const repository = copyRepositoryFixture();
    const configPath = path.join(repository, "release-please-config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      packages: { ".": { "extra-files": Array<{ path: string }> } };
    };
    config.packages["."]["extra-files"].push({ path: "missing-release-file.ts" });
    write(configPath, `${JSON.stringify(config, null, 2)}\n`);

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects a stale webhook deployment image pin", () => {
    const repository = copyRepositoryFixture();
    const composePath = path.join(repository, "deploy/webhook/compose.yml");
    const rootPackage = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")) as {
      version: string;
    };
    write(
      composePath,
      readFileSync(composePath, "utf8").replace(
        `ghcr.io/somus/pipr:v${rootPackage.version}`,
        "ghcr.io/somus/pipr:v0.0.0",
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects a stale webhook environment image pin", () => {
    const repository = copyRepositoryFixture();
    const environmentPath = path.join(repository, "deploy/webhook/.env.example");
    const rootPackage = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")) as {
      version: string;
    };
    write(
      environmentPath,
      readFileSync(environmentPath, "utf8").replace(
        `ghcr.io/somus/pipr:v${rootPackage.version}`,
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
        '      - run: npm publish "dist/npm/usepipr-runtime-${{ steps.version.outputs.version }}.tgz" --access public\n',
        "",
      ),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects missing npm tarball verification", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace("      - run: bun run check:npm-tarballs\n", ""),
    );

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects npm tarball verification after package publication", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    const verificationStep = "      - run: bun run check:npm-tarballs\n";
    const firstPublish =
      '      - run: npm publish "dist/npm/usepipr-sdk-${{ steps.version.outputs.version }}.tgz" --access public\n';
    const workflow = readFileSync(workflowPath, "utf8")
      .replace(verificationStep, "")
      .replace(firstPublish, `${firstPublish}${verificationStep}`);
    write(workflowPath, workflow);

    expect(runScript("scripts/check-release-metadata.ts", [], repository)).not.toBe(0);
  });

  it("rejects a missing release artifact verification step", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(
        "      - run: bun run check:release-artifacts\n",
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

  it("keeps package Zod versions exact without a root catalog entry", () => {
    const rootPackageJson = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    ) as { catalog?: Record<string, string> };

    expect(rootPackageJson.catalog?.zod).toBeUndefined();
    for (const packagePath of [
      "packages/sdk/package.json",
      "packages/runtime/package.json",
      "packages/evals/package.json",
    ]) {
      const pkg = JSON.parse(readFileSync(path.join(repoRoot, packagePath), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(pkg.dependencies?.zod).toBe("4.4.3");
    }
  });

  it("rejects a registry runtime dependency in the private docs workspace", () => {
    const repository = copyRepositoryFixture();
    const packagePath = path.join(repository, "apps/docs/package.json");
    const pkg = JSON.parse(readFileSync(packagePath, "utf8")) as {
      devDependencies: Record<string, string>;
    };
    pkg.devDependencies["@usepipr/runtime"] = "0.0.0";
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

  it("adds the self-review workflow to the post-publish dogfood update PR", () => {
    const releaseWorkflow = readFileSync(
      path.join(repoRoot, ".github/workflows/release.yml"),
      "utf8",
    );

    expect(releaseWorkflow).toContain("bun run sync:release-lockfile");
    expect(releaseWorkflow).toContain(
      "git add .pipr/package.json .pipr/bun.lock .github/workflows/pipr.yml",
    );
  });

  it("rejects a post-publish dogfood PR that omits the self-review workflow", () => {
    const repository = copyRepositoryFixture();
    const workflowPath = path.join(repository, ".github/workflows/release.yml");
    write(
      workflowPath,
      readFileSync(workflowPath, "utf8").replace(
        "git add .pipr/package.json .pipr/bun.lock .github/workflows/pipr.yml",
        "git add .pipr/package.json .pipr/bun.lock",
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

function parseWorkflow(relativePath: string): Workflow {
  return Bun.YAML.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as Workflow;
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

function scopeChanged(scope: ChangedScope, relativePath: string): boolean {
  const repository = changedScopeRepository(relativePath);
  const result = changedScopeResult(scope, repository, {
    EVENT_NAME: "pull_request",
    PR_BASE_SHA: git(repository, "rev-parse", "HEAD~1"),
    PR_HEAD_SHA: git(repository, "rev-parse", "HEAD"),
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "changed-scope failed");
  }
  return result.stdout.trim() === "changed=true";
}

function changedScopeResult(
  scope: ChangedScope,
  repository: string,
  env: Record<string, string | undefined>,
): { exitCode: number; stdout: string; stderr: string } {
  return scriptResult(path.join(repoRoot, "scripts/changed-scope.ts"), [scope], repository, {
    GITHUB_OUTPUT: undefined,
    ...env,
  });
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
  const previousVersion = (
    JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8")) as { version: string }
  ).version;
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

  const releasePleaseConfig = JSON.parse(
    readFileSync(path.join(repository, "release-please-config.json"), "utf8"),
  ) as {
    packages: {
      ".": { "extra-files": Array<{ type: string; path: string; glob?: boolean }> };
    };
  };
  const genericFiles = releasePleaseConfig.packages["."]["extra-files"].filter(
    (extraFile) => extraFile.type === "generic" && !extraFile.glob,
  );
  for (const { path: relativePath } of genericFiles) {
    const filePath = path.join(repository, relativePath);
    write(filePath, readFileSync(filePath, "utf8").replaceAll(previousVersion, version));
  }
  const genericGlobs = releasePleaseConfig.packages["."]["extra-files"].filter(
    (extraFile) => extraFile.type === "generic" && extraFile.glob,
  );
  for (const { path: pattern } of genericGlobs) {
    for (const relativePath of new Bun.Glob(pattern).scanSync({
      cwd: repository,
      onlyFiles: true,
    })) {
      const filePath = path.join(repository, relativePath);
      write(filePath, readFileSync(filePath, "utf8").replaceAll(previousVersion, version));
    }
  }
}
