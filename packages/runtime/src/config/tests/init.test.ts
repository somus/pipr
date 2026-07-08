import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type PiRunner,
  type ReviewRuntimeResult,
  runTaskRuntime,
} from "../../review/task/task-runtime.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { initOfficialMinimalProject } from "../init.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../project.js";
import {
  listOfficialInitRecipes,
  officialInitRecipeFiles,
  supportedOfficialInitRecipes,
} from "../recipes.js";
import { useLocalInitSdk } from "./helpers/local-init-sdk.js";

useLocalInitSdk();

const configCoreInitFiles = [path.join(".pipr", "config.ts")];

const packageInitFiles = [
  path.join(".pipr", "package.json"),
  path.join(".pipr", "tsconfig.json"),
  path.join(".pipr", ".gitignore"),
  path.join(".pipr", "bun.lock"),
];

const defaultInitFiles = [
  ...configCoreInitFiles,
  ...packageInitFiles,
  path.join(".github", "workflows", "pipr.yml"),
];

describe("initOfficialMinimalProject", () => {
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
      "@types/bun": "1.3.14",
      typescript: "6.0.3",
    });
    expect(await Bun.file(path.join(rootDir, ".pipr", "bun.lock")).text()).toContain(
      '"lockfileVersion"',
    );
    expect(await Bun.file(path.join(rootDir, ".pipr", ".gitignore")).text()).toBe("node_modules\n");
    const workflow = await Bun.file(path.join(rootDir, ".github", "workflows", "pipr.yml")).text();
    expect(workflow).toContain("uses: somus/pipr@v0.3.3"); // x-release-please-version
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
    expect(inspectRuntimePlan(project.plan, ".pipr/config.ts").tools).toEqual([
      "r2_memory_search",
      "r2_memory_store",
    ]);
  });

  it("initializes every official recipe and validates the generated config", async () => {
    expect(supportedOfficialInitRecipes).toContain("rich-review");
    expect(supportedOfficialInitRecipes).toContain("fix-suggestions");
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

  it("initializes the structured review recipe with category and severity metadata", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-rich-review-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "rich-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();

    expect(configTs).toContain("reviewSummarySchema");
    expect(configTs).toContain("changeSummary: z.array(z.string()).min(1).max(4)");
    expect(configTs).toContain("reviewerFocus: z.array(z.string()).max(4)");
    expect(configTs).toContain("summaryTable(result.summary, result.findings.length)");
    expect(configTs).toContain("severity");
    expect(configTs).toContain("category");
    expect(configTs).toContain("@pipr review");
    expect(configTs).toContain('"## Findings"');
    expect(configTs).not.toContain('"## Review"');
    expect(configTs).not.toContain("rich-review");
    expect(inspectRuntimePlan(project.plan, ".pipr/config.ts").agents).toContain("reviewer");
    expect(inspectRuntimePlan(project.plan, ".pipr/config.ts").tasks).toContain("review");
  });

  it("initializes the security SAST recipe with structured summary rendering", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-security-sast-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "security-sast",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();

    expect(configTs).toContain("type SecuritySummary");
    expect(configTs).toContain(
      'required: ["headline", "riskLevel", "riskSummary", "reviewerFocus"]',
    );
    expect(configTs).toContain("diagramMermaid");
    expect(configTs).toContain("attackPathDiagramBlock");
    expect(configTs).toContain("hasConcreteHighOrCriticalRisk");
    expect(configTs).toContain("$" + "{fence}mermaid");
    expect(inspectRuntimePlan(project.plan, ".pipr/config.ts").agents).toContain("security-sast");
    expect(inspectRuntimePlan(project.plan, ".pipr/config.ts").tasks).toContain("security-sast");
  });

  it("renders the structured review recipe as a scannable clean summary", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-rich-review-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "rich-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: jsonPiRunner({
        summary: {
          headline: "Release automation skip is preserved",
          changeSummary: ["Adds an issue-comment guard for release-please release notes."],
          riskLevel: "low",
          riskSummary: "The event guard is narrow and leaves pull request behavior intact.",
          reviewerFocus: ["Confirm release-please comment markers stay stable."],
        },
        findings: [],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("## Summary");
    expect(result.mainComment).toContain(
      "## Summary\n\n**Release automation skip is preserved**\n\n| Outcome | Risk | Risk summary |",
    );
    expect(result.mainComment).toContain("**Release automation skip is preserved**");
    expect(result.mainComment).toContain("| Outcome | Risk | Risk summary |");
    expect(result.mainComment).toContain(
      "| No findings | Low | The event guard is narrow and leaves pull request behavior intact. |",
    );
    expect(result.mainComment).toContain("## What Changed");
    expect(result.mainComment).toContain(
      "- Adds an issue-comment guard for release-please release notes.",
    );
    expect(result.mainComment).toContain("## Reviewer Focus");
    expect(result.mainComment).toContain("- Confirm release-please comment markers stay stable.");
    expect(result.mainComment).not.toContain("<summary>Finding rationales</summary>");
    expect(result.inlineCommentDrafts).toEqual([]);
  });

  it("renders structured review findings with rationales and inline comments", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-rich-review-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "rich-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: jsonPiRunner({
        summary: {
          headline: "One correctness risk needs review",
          changeSummary: ["Changes the return value used by the request handler."],
          riskLevel: "medium",
          riskSummary: "The changed path affects runtime behavior and has one concrete issue.",
          reviewerFocus: [],
        },
        findings: [
          {
            title: "Fallback value is skipped",
            severity: "medium",
            category: "correctness",
            rationale: "The new branch returns before the fallback can run.",
            body: "This returns before the fallback path can execute.",
            path: "src/a.ts",
            rangeId: "range-1",
            side: "RIGHT",
            startLine: 10,
            endLine: 10,
          },
        ],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("| 1 finding | Medium |");
    expect(result.mainComment).toContain("| Medium | correctness | Fallback value is skipped |");
    expect(result.mainComment).toContain("No special reviewer focus.");
    expect(result.mainComment).toContain("<summary>Finding rationales</summary>");
    expect(result.mainComment).toContain("The new branch returns before the fallback can run.");
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.inlineCommentDrafts[0]?.body).toContain(
      "**Medium correctness:** Fallback value is skipped.",
    );
  });

  it("renders the security SAST recipe as a clean security summary without a diagram", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-security-sast-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "security-sast",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: jsonPiRunner({
        summary: {
          headline: "No exploitable security path found",
          riskLevel: "low",
          riskSummary: "The changed workflow guard does not expose a new privileged path.",
          reviewerFocus: [],
        },
        risks: [],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("## Summary");
    expect(result.mainComment).toContain(
      "## Summary\n\n**No exploitable security path found**\n\n| Status | Summary risk | Max severity | Risks |",
    );
    expect(result.mainComment).toContain("**No exploitable security path found**");
    expect(result.mainComment).toContain("| Status | Summary risk | Max severity | Risks |");
    expect(result.mainComment).toContain("| Pass | Low | None | 0 |");
    expect(result.mainComment).toContain("No special security follow-up.");
    expect(result.mainComment).not.toContain("<summary>Attack path diagram</summary>");
    expect(result.taskChecks).toContainEqual({
      taskName: "security-sast",
      conclusion: "success",
      summary: "No high or critical security risks found.",
    });
  });

  it("renders high security risks with rationales, diagram, check failure, and inline comments", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-security-sast-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "security-sast",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: jsonPiRunner({
        summary: {
          headline: "Privileged issue-comment path needs review",
          riskLevel: "high",
          riskSummary: "A changed issue-comment condition could reach a privileged workflow path.",
          reviewerFocus: ["Confirm only trusted release automation can trigger this path."],
        },
        risks: [
          {
            title: "Issue comments can trigger privileged workflow",
            category: "auth",
            severity: "high",
            rationale: "An attacker-controlled issue comment can satisfy the new guard.",
            finding: {
              body: "This guard accepts issue comments without proving the actor is trusted.",
              path: "src/a.ts",
              rangeId: "range-1",
              side: "RIGHT",
              startLine: 10,
              endLine: 10,
            },
          },
        ],
        diagramMermaid: [
          "flowchart TD",
          "  A[Issue comment] --> B[Workflow guard]",
          "  B --> C[Privileged job]",
        ].join("\n"),
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("| Fail | High | High | 1 |");
    expect(result.mainComment).toContain(
      "| High | auth | Issue comments can trigger privileged workflow |",
    );
    expect(result.mainComment).toContain("<summary>Risk rationales</summary>");
    expect(result.mainComment).toContain("<summary>Attack path diagram</summary>");
    expect(result.mainComment).toContain("```mermaid");
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.taskChecks).toContainEqual({
      taskName: "security-sast",
      conclusion: "failure",
      summary: "High or critical security risk found.",
    });
  });

  it("initializes the fix suggestions recipe as a command-first exact patch workflow", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-fix-suggestions-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "fix-suggestions",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();
    const inspected = inspectRuntimePlan(project.plan, ".pipr/config.ts");

    expect(configTs).toContain("suggestedFix: z.string().min(1)");
    expect(configTs).toContain("isPublishableSuggestion");
    expect(configTs).toContain("isPublishableSuggestedFixSelection");
    expect(configTs).toContain("suggestionIncludesUnselectedContext");
    expect(configTs).toContain("@pipr improve");
    expect(configTs).toContain("maxInlineComments: 6");
    expect(inspected.agents).toContain("fix-suggestions");
    expect(inspected.tasks).toContain("fix-suggestions");
    expect(inspected.commands).toContainEqual({
      pattern: "@pipr improve",
      task: "fix-suggestions",
      permission: "write",
    });
  });

  it("initializes the quality gate recipe with commentable blocker filtering", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-quality-gate-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "quality-gate",
      minimal: true,
    });
    const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();

    expect(configTs).toContain("commentableBlockers");
    expect(configTs).toContain("commentableRangeForFinding");
    expect(configTs).toContain("droppedBlockersNote");
    expect(configTs).not.toContain("if (result.blockers.length > 0)");
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

  it("initializes the PR briefing recipe with dynamic diagram fences", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-pr-briefing-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "pr-briefing",
      minimal: true,
    });
    const configTs = await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text();

    expect(configTs).toContain("function markdownFenceFor");
    expect(configTs).toContain("$" + "{fence}mermaid");
    expect(configTs).not.toContain('"```mermaid",\n    diagram,\n    "```"');
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
      "uses: somus/pipr@v0.3.3", // x-release-please-version
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

function eventContext(): ChangeRequestEventContext {
  return {
    eventName: "pull_request",
    action: "opened",
    platform: { id: "github" },
    repository: { slug: "local/pipr" },
    change: {
      number: 1,
      title: "PR title",
      description: "PR body",
      base: { sha: "base" },
      head: { sha: "head" },
    },
    workspace: process.cwd(),
  };
}

function jsonPiRunner(output: unknown): PiRunner {
  return async () => ({
    exitCode: 0,
    stdout: JSON.stringify(output),
    stderr: "",
    durationMs: 1,
  });
}

function assertReviewResult(
  result: ReviewRuntimeResult,
): asserts result is Extract<ReviewRuntimeResult, { kind: "review" }> {
  expect(result.kind).toBe("review");
  if (result.kind !== "review") {
    throw new Error(`expected review runtime result, received ${result.kind}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  return await Bun.file(filePath).exists();
}

function githubExpression(expression: string): string {
  return `$${["{{ ", expression, " }}"].join("")}`;
}
