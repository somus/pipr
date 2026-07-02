import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initOfficialMinimalProject, listOfficialMinimalFiles } from "../init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../project.js";
import {
  listOfficialInitRecipes,
  officialInitRecipeFiles,
  supportedOfficialInitRecipes,
} from "../recipes.js";

const configCoreInitFiles = [path.join(".pipr", "config.ts")];

const packageInitFiles = [
  path.join(".pipr", "package.json"),
  path.join(".pipr", "tsconfig.json"),
  path.join(".pipr", ".gitignore"),
  path.join(".pipr", "bun.lock"),
];

describe("initOfficialMinimalProject", () => {
  it("creates the official minimal .pipr tree and validates it", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    const result = await initOfficialMinimalProject({ rootDir });
    const project = await loadRuntimeProject({ rootDir });

    expect(result.created).toEqual(expect.arrayContaining(listOfficialMinimalFiles()));
    expect(result.created).toEqual(expect.arrayContaining(packageInitFiles));
    expect(result.overwritten).toEqual([]);
    expect(await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text()).toContain(
      "pipr.review",
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", "tsconfig.json")).text()).toContain(
      "moduleResolution",
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", "package.json")).text()).toContain(
      "@usepipr/sdk",
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", "bun.lock")).text()).toContain(
      '"lockfileVersion"',
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", ".gitignore")).text()).toBe("node_modules\n");
    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();
    expect(workflow).toContain("uses: somus/pipr@v0.1.3"); // x-release-please-version
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
    expect(inspectRuntimePlan(project.plan, ".pipr/config.ts").tools).toEqual([
      "r2_memory_search",
      "r2_memory_store",
    ]);
  });

  it("initializes every official recipe and validates the generated config", async () => {
    expect(listOfficialInitRecipes().map((recipe) => recipe.id)).toEqual([
      ...supportedOfficialInitRecipes,
    ]);

    for (const recipe of supportedOfficialInitRecipes) {
      const { rootDir, result, project } = await initializedConfigOnlyProject(recipe);

      expect(result.created).toEqual(expect.arrayContaining(configCoreInitFiles));
      expect(result.created).toEqual(expect.arrayContaining(packageInitFiles));
      for (const file of recipeConfigFiles(recipe)) {
        expect(result.created).toContain(file);
      }
      expect(result.overwritten).toEqual([]);
      expect(project.kind).toBe("typescript");
      const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();
      expect(configTs).toContain("definePipr");
      expect(configTs).not.toContain("pipr.local");
      expect(configTs).not.toContain('section("Diff Manifest"');
      expect(configTs).not.toContain("json(input.manifest");
      expect(configTs).not.toContain("input.manifest");
    }
  });

  it("initializes advanced recipes with inspectable agents, tools, and commands", async () => {
    const multiAgentRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-multi-agent-"));
    const pluginRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-plugin-tool-"));
    const commandRootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-command-"));

    await initOfficialMinimalProject({
      rootDir: multiAgentRootDir,
      adapters: [],
      recipe: "multi-agent-review",
    });
    await initOfficialMinimalProject({
      rootDir: pluginRootDir,
      adapters: [],
      recipe: "plugin-tool-review",
    });
    await initOfficialMinimalProject({
      rootDir: commandRootDir,
      adapters: [],
      recipe: "interactive-ask",
    });

    const multiAgent = await loadRuntimeProject({ rootDir: multiAgentRootDir });
    const pluginTool = await loadRuntimeProject({ rootDir: pluginRootDir });
    const command = await loadRuntimeProject({ rootDir: commandRootDir });
    const pluginConfig = await Bun.file(path.join(pluginRootDir, ".pipr", "config.ts")).text();
    const pluginMemory = await Bun.file(path.join(pluginRootDir, ".pipr", "r2-memory.ts")).text();

    expect(inspectRuntimePlan(multiAgent.plan, ".pipr/config.ts").agents).toEqual(
      expect.arrayContaining([
        "security-specialist",
        "test-specialist",
        "maintainability-specialist",
        "review-aggregator",
      ]),
    );
    expect(inspectRuntimePlan(pluginTool.plan, ".pipr/config.ts").tools).toEqual([
      "r2_memory_search",
      "r2_memory_store",
    ]);
    expect(pluginConfig).toContain('import { r2MemoryPlugin } from "./r2-memory";');
    expect(pluginConfig).not.toContain("new S3Client");
    expect(pluginConfig).not.toContain("memory.store.run");
    expect(pluginMemory).toContain('import { S3Client } from "bun";');
    expect(pluginMemory).toContain("export function r2MemoryPlugin");
    expect(pluginMemory).toContain("bucket.list({ prefix: memoryPrefix(ctx, options)");
    expect(pluginMemory).toContain("[ctx.repository.owner, ctx.repository.name]");
    expect(pluginMemory).toContain("memoryKey(input.subject, ctx, options)");
    expect(inspectRuntimePlan(command.plan, ".pipr/config.ts").commands).toEqual([
      {
        pattern: "@pipr ask <question...>",
        task: "interactive-ask",
        permission: "read",
      },
    ]);
  });

  it("adds R2 memory secrets to the plugin recipe workflow", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-plugin-tool-"));

    await initOfficialMinimalProject({ rootDir, recipe: "plugin-tool-review" });

    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();
    expect(workflow).toContain(
      `PIPR_R2_MEMORY_BUCKET: ${githubExpression("secrets.PIPR_R2_MEMORY_BUCKET")}`,
    );
    expect(workflow).toContain(
      `PIPR_R2_MEMORY_ENDPOINT: ${githubExpression("secrets.PIPR_R2_MEMORY_ENDPOINT")}`,
    );
    expect(workflow).toContain(
      `PIPR_R2_MEMORY_ACCESS_KEY_ID: ${githubExpression("secrets.PIPR_R2_MEMORY_ACCESS_KEY_ID")}`,
    );
    expect(workflow).toContain(
      `PIPR_R2_MEMORY_SECRET_ACCESS_KEY: ${githubExpression("secrets.PIPR_R2_MEMORY_SECRET_ACCESS_KEY")}`,
    );
  });

  it("generates SDK types that preserve optional Zod object fields", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
    await initOfficialMinimalProject({ rootDir });
    await Bun.write(
      path.join(rootDir, ".pipr", "config.ts"),
      `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
  });

  const summary = pipr.schema({
    id: "custom/summary",
    schema: z.strictObject({
      title: z.string().optional(),
      body: z.string(),
    }),
  });

  const validSummary: ReturnType<typeof summary.parse> = { body: "ok" };
  void validSummary;
});
`,
    );

    const validation = await validateProject({ rootDir });
    expect(validation.kind).toBe("typescript");
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
      "uses: somus/pipr@v0.1.3", // x-release-please-version
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

  it("rejects unsupported init adapters", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));

    await expect(initOfficialMinimalProject({ rootDir, adapters: ["gitlab"] })).rejects.toThrow(
      "Unsupported pipr init adapter 'gitlab'. Supported adapters: github",
    );
    await expect(
      initOfficialMinimalProject({ rootDir, adapters: ["none", "github"] }),
    ).rejects.toThrow("Adapter 'none' cannot be mixed with other init adapters");
    await expect(initOfficialMinimalProject({ rootDir, adapters: [""] })).rejects.toThrow(
      "Unsupported pipr init adapter ''. Supported adapters: github",
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

async function listFiles(rootDir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  const pending = [prefix];
  while (pending.length > 0) {
    const current = pending.pop() ?? "";
    for (const entry of await readdir(path.join(rootDir, current), { withFileTypes: true })) {
      const relativePath = current ? path.join(current, entry.name) : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          continue;
        }
        pending.push(relativePath);
      } else {
        files.push(relativePath.split(path.sep).join("/"));
      }
    }
  }
  return files.sort();
}

async function initializedConfigOnlyProject(recipe?: string): Promise<{
  rootDir: string;
  result: Awaited<ReturnType<typeof initOfficialMinimalProject>>;
  project: Awaited<ReturnType<typeof loadRuntimeProject>>;
}> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
  const result = await initOfficialMinimalProject({ rootDir, adapters: [], recipe });
  const project = await loadRuntimeProject({ rootDir });
  return { rootDir, result, project };
}

function expectConfigOnlyInitResult(
  result: Awaited<ReturnType<typeof initOfficialMinimalProject>>,
): void {
  expect(result.created).toEqual(expect.arrayContaining(configCoreInitFiles));
  expect(result.created).toEqual(expect.arrayContaining(packageInitFiles));
  expect(result.overwritten).toEqual([]);
}

async function projectWithCustomConfig(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-"));
  await mkdir(path.join(rootDir, ".pipr"), { recursive: true });
  await Bun.write(path.join(rootDir, ".pipr", "config.ts"), "custom: true\n");
  return rootDir;
}

function recipeConfigFiles(recipe?: string): string[] {
  return officialInitRecipeFiles(recipe).map((file) => path.join(".pipr", file.relativePath));
}

async function fileExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}

function githubExpression(expression: string): string {
  return `$${["{{ ", expression, " }}"].join("")}`;
}
