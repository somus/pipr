import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runtimeVersion } from "../../shared/version.js";
import { officialInitPackageManifest } from "../init.js";
import { renderOfficialGithubWorkflow } from "../official-github-workflow.js";
import { inspectRuntimePlan, loadRuntimeProject } from "../project.js";
import { defaultTypesBunVersion, defaultTypescriptVersion } from "../scaffold-versions.js";
import { initOfficialMinimalProjectWithLocalDependencies as initOfficialMinimalProject } from "./helpers/local-init-sdk.js";
import {
  cleanupTemporaryDirectories,
  defaultInitFiles,
  expectConfigOnlyInitResult,
  fileExists,
  initializedConfigOnlyProject,
  listFiles,
  mkdtemp,
  packageInitFiles,
  projectWithCustomConfig,
  useLocalInitSdk,
} from "./init-fixtures.js";

afterAll(await useLocalInitSdk());
afterEach(cleanupTemporaryDirectories);

describe("initOfficialMinimalProject: project scaffolding and safety", () => {
  it("keeps published dependency versions in the production scaffold manifest", () => {
    expect(officialInitPackageManifest({})).toEqual({
      private: true,
      dependencies: { "@usepipr/sdk": runtimeVersion },
      devDependencies: {
        "@types/bun": defaultTypesBunVersion,
        typescript: defaultTypescriptVersion,
      },
    });
  });

  it("renders the same non-minimal GitHub workflow used by recipe docs", () => {
    const runtimeWorkflow = renderOfficialGithubWorkflow({ recipe: "security-sast" });
    const documentedWorkflow = renderOfficialGithubWorkflow({
      recipe: "security-sast",
      includeReleasePleaseVersionMarker: true,
    });

    expect(documentedWorkflow.replace(" # x-release-please-version", "")).toBe(runtimeWorkflow);
    expect(runtimeWorkflow).toContain("actions/cache@v4");
  });

  it("creates the official minimal .pipr tree and validates it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir });
    const project = await loadRuntimeProject({ rootDir });
    const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();

    expect(result.created).toEqual(expect.arrayContaining(defaultInitFiles));
    expect(result.created).toEqual(expect.arrayContaining(packageInitFiles));
    expect(result.overwritten).toEqual([]);
    expect(configTs).toContain("pipr.review");
    expect(configTs).toContain("## Review Result");
    expect(configTs).toContain("See inline comments in the diff.");
    expect(await Bun.file(path.join(rootDir, ".pipr", "tsconfig.json")).text()).toContain(
      "moduleResolution",
    );
    const packageJson = JSON.parse(
      await Bun.file(path.join(rootDir, ".pipr", "package.json")).text(),
    );
    expect(packageJson.dependencies).toMatchObject({ "@usepipr/sdk": expect.any(String) });
    expect(packageJson.devDependencies).toMatchObject({
      "@types/bun": expect.stringMatching(/^file:/),
      typescript: expect.stringMatching(/^file:/),
    });
    expect(await Bun.file(path.join(rootDir, ".pipr", "bun.lock")).text()).toContain(
      '"lockfileVersion"',
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", ".gitignore")).text()).toBe("node_modules\n");
    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();
    expect(workflow).toContain("uses: somus/pipr@v0.5.0"); // x-release-please-version
    expect(workflow).toContain("actions/cache@v4");
    expect(workflow).toContain("hashFiles('.pipr/bun.lock')");
    expect(workflow).toContain("checks: write");
    expect(workflow).toContain("pull_request_review_comment:");
    expect(workflow).toContain("types: [created]");
    expect(workflow).not.toContain("config-dir:");
    expect([...workflow.matchAll(/^ {8}with:$/gm)]).toHaveLength(2);
    expect(workflow).not.toContain("provider-id:");
    expect(workflow).not.toContain("provider: deepseek");
    expect(workflow).not.toContain("model: deepseek-v4-pro");
    expect(workflow).not.toContain("api-key-env: DEEPSEEK_API_KEY");
    expect(workflow).toContain("DEEPSEEK_API_KEY:");
    expect(workflow).toContain("secrets.DEEPSEEK_API_KEY");
    expect(await listFiles(rootDir)).toEqual(
      expect.arrayContaining([
        ".github/workflows/pipr.yml",
        ".pipr/.gitignore",
        ".pipr/bun.lock",
        ".pipr/config.ts",
        ".pipr/package.json",
        ".pipr/tsconfig.json",
      ]),
    );
    expect(await listFiles(path.join(rootDir, ".pipr"))).toEqual(
      expect.arrayContaining([
        ".gitignore",
        "bun.lock",
        "config.ts",
        "package.json",
        "tsconfig.json",
      ]),
    );
    expect(project.kind).toBe("typescript");
    expect(project.settings.config.defaultProvider).toBe("deepseek/deepseek-v4-pro");
    expect(project.settings.config.publication.maxInlineComments).toBe(5);
    expect(configTs).toContain('timeout: "10m"');
  });

  it("can initialize only the pipr config files without adapter files", async () => {
    const { rootDir, result, project } = await initializedConfigOnlyProject();

    expectConfigOnlyInitResult(result);
    expect(await listFiles(rootDir)).toEqual(
      expect.arrayContaining([
        ".pipr/bun.lock",
        ".pipr/config.ts",
        ".pipr/package.json",
        ".pipr/tsconfig.json",
      ]),
    );
    expect(await fileExists(path.join(rootDir, ".github", "workflows", "pipr.yml"))).toBe(false);
    expect(project.kind).toBe("typescript");
  });

  it("can initialize a minimal single-file config without package.json", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "plugin-tool-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    expect(result.created.sort()).toEqual([
      path.join(".pipr", "config.ts"),
      path.join(".pipr", "r2-memory.ts"),
    ]);
    expect(result.overwritten).toEqual([]);
    expect(await fileExists(path.join(rootDir, ".pipr", "tsconfig.json"))).toBe(false);
    expect(await fileExists(path.join(rootDir, ".pipr", "package.json"))).toBe(false);
    expect(await fileExists(path.join(rootDir, ".pipr", ".gitignore"))).toBe(false);
    const inspection = inspectRuntimePlan(project.plan, ".pipr/config.ts");
    expect(inspection.tools).toEqual(["r2_memory_search", "r2_memory_store"]);
    expect(inspection.commands).toEqual([
      {
        pattern: "@pipr memory-review",
        task: "memory-assisted-review",
        permission: "write",
      },
      {
        pattern: "@pipr remember <lesson...>",
        task: "remember-review-memory",
        permission: "write",
      },
    ]);
  });

  it("refuses to overwrite existing pipr files without force", async () => {
    const rootDir = await projectWithCustomConfig();

    await expect(initOfficialMinimalProject({ rootDir })).rejects.toThrow(
      "Use --force to replace existing .pipr files",
    );
    await expect(Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).resolves.toBe(
      "custom: true\n",
    );
  });

  it("overwrites official target files when force is explicit", async () => {
    const rootDir = await projectWithCustomConfig();

    const result = await initOfficialMinimalProject({ rootDir, force: true });

    expect(result.overwritten).toEqual([path.join(".pipr", "config.ts")]);
    expect(await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).toContain("definePipr");
  });

  it("creates the GitHub workflow with the selected config directory", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir, configDir: "config/pipr" });
    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();

    expect(result.created).toContain(path.join(".github", "workflows", "pipr.yml"));
    expect(workflow).toContain("config-dir: config/pipr");
    expect(workflow).toContain("hashFiles('config/pipr/bun.lock')");
    expect(workflow).not.toContain("hashFiles('.pipr/bun.lock')");
    expect([...workflow.matchAll(/^ {8}with:$/gm)]).toHaveLength(3);
    expect(await Bun.file(path.join(rootDir, "config", "pipr", "config.ts")).text()).toContain(
      "pipr.review",
    );
  });

  it("refuses and force-overwrites an existing GitHub workflow", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".github", "workflows"), { recursive: true });
    await Bun.write(path.join(rootDir, ".github", "workflows", "pipr.yml"), "custom: true\n");

    await expect(initOfficialMinimalProject({ rootDir })).rejects.toThrow(
      "Use --force to replace existing .pipr files",
    );
    await expect(
      Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text(),
    ).resolves.toBe("custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, force: true });

    expect(result.overwritten).toEqual([path.join(".github", "workflows", "pipr.yml")]);
    expect(await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text()).toContain(
      "uses: somus/pipr@v0.5.0", // x-release-please-version
    );
  });

  it("does not conflict with an existing GitHub workflow when no adapter is selected", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await mkdir(path.join(rootDir, ".github", "workflows"), { recursive: true });
    await Bun.write(path.join(rootDir, ".github", "workflows", "pipr.yml"), "custom: true\n");

    const result = await initOfficialMinimalProject({ rootDir, adapters: [] });

    expectConfigOnlyInitResult(result);
    expect(await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text()).toBe(
      "custom: true\n",
    );
  });

  it("creates an opt-in GitLab merge request pipeline", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({
      rootDir,
      configDir: "config/pipr",
      adapters: ["gitlab"],
    });
    const pipeline = await Bun.file(path.join(rootDir, ".gitlab-ci.yml")).text();

    expect(result.created).toContain(".gitlab-ci.yml");
    expect(pipeline).toContain("ghcr.io/somus/pipr:v0.5.0"); // x-release-please-version
    expect(pipeline).toContain("pipr host-run --host gitlab --config-dir config/pipr");
    expect(pipeline).toContain('PIPR_CODE_HOST: "gitlab"');
    expect(pipeline).toContain('GIT_DEPTH: "0"');
    expect(await fileExists(path.join(rootDir, ".github", "workflows", "pipr.yml"))).toBe(false);
  });

  it("creates an Azure trusted-runner environment template without a credentialed PR pipeline", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({
      rootDir,
      configDir: "config/pipr",
      adapters: ["azure-devops"],
    });
    const environment = await Bun.file(path.join(rootDir, "azure-devops.pipr.env.example")).text();

    expect(result.created).toContain("azure-devops.pipr.env.example");
    expect(environment).toContain("AZURE_DEVOPS_BEARER_TOKEN=");
    expect(environment).toContain("PIPR_AZURE_SUBSCRIPTION_ID=");
    expect(environment).toContain("PIPR_WEBHOOK_SECRET=");
    expect(await fileExists(path.join(rootDir, "azure-pipelines.pipr.yml"))).toBe(false);
  });

  it("creates a Bitbucket trusted-runner environment template", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const result = await initOfficialMinimalProject({
      rootDir,
      configDir: "config/pipr",
      adapters: ["bitbucket"],
    });
    const environment = await Bun.file(path.join(rootDir, "bitbucket.pipr.env.example")).text();
    expect(result.created).toContain("bitbucket.pipr.env.example");
    expect(environment).toContain("BITBUCKET_WORKSPACE=");
    expect(environment).toContain("BITBUCKET_EMAIL=");
    expect(environment).toContain("BITBUCKET_API_TOKEN=");
    expect(environment).toContain("BITBUCKET_PERMISSION_API_TOKEN=");
    expect(environment).toContain("PIPR_WEBHOOK_SECRET=");
  });

  it("rejects unsupported init adapters", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    await expect(initOfficialMinimalProject({ rootDir, adapters: ["unknown"] })).rejects.toThrow(
      "Unsupported pipr init adapter 'unknown'. Supported adapters: github, gitlab, azure-devops, bitbucket",
    );
    await expect(
      initOfficialMinimalProject({ rootDir, adapters: ["none", "github"] }),
    ).rejects.toThrow("Adapter 'none' cannot be mixed with other init adapters");
    await expect(initOfficialMinimalProject({ rootDir, adapters: [""] })).rejects.toThrow(
      "Unsupported pipr init adapter ''. Supported adapters: github, gitlab, azure-devops",
    );
  });

  it("rejects unsupported init recipes", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    await expect(
      initOfficialMinimalProject({ rootDir, adapters: [], recipe: "missing" }),
    ).rejects.toThrow("Unsupported pipr init recipe 'missing'. Supported recipes:");
  });

  it("rejects symlinked target parent directories", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const outsideDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-outside-"));
    await symlink(outsideDir, path.join(rootDir, ".pipr"));

    await expect(initOfficialMinimalProject({ rootDir, force: true })).rejects.toThrow(
      "symbolic links are not supported",
    );
  });

  it("rejects configDir paths outside the repo root", async () => {
    const parentDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    const rootDir = path.join(parentDir, "repo");
    await mkdir(rootDir);

    await expect(
      initOfficialMinimalProject({ rootDir, configDir: "../outside/.pipr" }),
    ).rejects.toThrow("configDir must be inside rootDir");
  });
});
