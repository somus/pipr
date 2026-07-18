import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdtemp as createTemporaryDirectory, mkdir, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type PiRunner,
  type ReviewRuntimeResult,
  runTaskRuntime,
} from "../../review/task/task-runtime.js";
import { runtimeVersion } from "../../shared/version.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import type { ChangeRequestEventContext } from "../../types.js";
import { officialInitPackageManifest } from "../init.js";
import { renderOfficialGithubWorkflow } from "../official-github-workflow.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../project.js";
import {
  listOfficialInitRecipes,
  officialInitRecipeFiles,
  supportedOfficialInitRecipes,
} from "../recipes.js";
import { defaultTypesBunVersion, defaultTypescriptVersion } from "../scaffold-versions.js";
import {
  initOfficialMinimalProjectWithLocalDependencies as initOfficialMinimalProject,
  useLocalInitSdk,
} from "./helpers/local-init-sdk.js";

const cleanupLocalInitSdk = await useLocalInitSdk();
afterAll(cleanupLocalInitSdk);
const temporaryDirectories = new Set<string>();
afterEach(async () => {
  await Promise.all(
    [...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  temporaryDirectories.clear();
});

async function mkdtemp(prefix: string): Promise<string> {
  const directory = await createTemporaryDirectory(prefix);
  temporaryDirectories.add(directory);
  return directory;
}

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
    expect(workflow).toContain("uses: somus/pipr@v0.4.2"); // x-release-please-version
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
      expect(configTs).not.toContain("Include suggestedFix only");
      expect(configTs).not.toContain("Omit suggestedFix when");
      expect(configTs).not.toContain("Omit suggestedFix for secrets");
      expect(configTs).not.toContain("suggestedFix directly fixes");
      expect(configTs).not.toContain("trailing-blank-line-only");
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
    expect(configTs).not.toContain("issueKey");
    expect(configTs).toContain("changeSummary: z.array(z.string()).min(1).max(4)");
    expect(configTs).toContain("reviewerFocus: z.array(z.string()).max(4)");
    expect(configTs).toContain("summaryTable(result.summary)");
    expect(configTs).not.toContain("commentableFindings");
    expect(configTs).toContain("severity");
    expect(configTs).toContain("category");
    expect(configTs).not.toContain('"nit"');
    expect(configTs).toContain("@pipr review");
    expect(configTs).not.toContain('"## Findings"');
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
    expect(configTs).toContain('required: ["headline", "riskSummary", "reviewerFocus"]');
    expect(configTs).toContain("diagramMermaid");
    expect(configTs).toContain("attackPathDiagramBlock");
    expect(configTs).toContain("commentableSecurityRisks");
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
      "## Summary\n\n**Release automation skip is preserved**\n\n| Risk | Risk summary |",
    );
    expect(result.mainComment).toContain("**Release automation skip is preserved**");
    expect(result.mainComment).not.toContain("| Outcome | Risk | Risk summary |");
    expect(result.mainComment).toContain(
      "| Low | The event guard is narrow and leaves pull request behavior intact. |",
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

  it("renders concise rich-review comments with collapsed rationales", async () => {
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
            title: "Fallback **value** is skipped",
            severity: "medium",
            category: "correctness",
            rationale: "The new branch returns </details> before the fallback can run.",
            body: "This returns <early> before the fallback path can execute.",
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
    expect(result.mainComment).toContain("**Findings:** 1");
    expect(result.mainComment).toContain("| Medium | The changed path affects runtime behavior");
    expect(result.mainComment).not.toContain(
      "| Medium | correctness | Fallback value is skipped |",
    );
    expect(result.mainComment).toContain("No special reviewer focus.");
    expect(result.mainComment).not.toContain("<summary>Finding rationales</summary>");
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.publicationPlan.reviewState.findings[0]).toMatchObject({
      anchorFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      issueFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.inlineCommentDrafts[0]?.body).toContain(
      [
        "**Medium correctness:** Fallback **value** is skipped",
        "",
        "This returns &lt;early&gt; before the fallback path can execute.",
        "",
        "<details>",
        "<summary>Rationale</summary>",
        "",
        "The new branch returns &lt;/details&gt; before the fallback can run.",
        "",
        "</details>",
      ].join("\n"),
    );
    expect(result.inlineCommentDrafts[0]?.body).not.toContain("**Issue**");
  });

  it("rejects rich-review titles containing line breaks", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-rich-review-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "rich-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    for (const title of ["First line\nSecond line", "First line\rSecond line"]) {
      await expect(
        runTaskRuntime({
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
                title,
                severity: "medium",
                category: "correctness",
                rationale: "The new branch returns before the fallback can run.",
                body: "This returns early before the fallback path can execute.",
                path: "src/a.ts",
                rangeId: "range-1",
                side: "RIGHT",
                startLine: 10,
                endLine: 10,
              },
            ],
          }),
        }),
      ).rejects.toThrow("Pi output failed schema validation after 1 repair attempt(s)");
    }
  });

  it("omits structured review findings with invalid diff anchors from all output", async () => {
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
          headline: "Review completed",
          changeSummary: ["Changes request handling."],
          riskLevel: "medium",
          riskSummary: "One reported item did not map to the diff.",
          reviewerFocus: [],
        },
        findings: [
          {
            title: "Invented location",
            severity: "medium",
            category: "correctness",
            rationale: "This location does not exist.",
            body: "This should never be rendered.",
            path: "src/missing.ts",
            rangeId: "missing-range",
            side: "RIGHT",
            startLine: 99,
            endLine: 99,
          },
        ],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).not.toContain("Invented location");
    expect(result.mainComment).not.toContain("**Findings:**");
    expect(result.mainComment).not.toContain("Omitted 1 finding");
    expect(result.inlineCommentDrafts).toEqual([]);
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
          riskSummary: "The changed workflow guard does not expose a new privileged path.",
          reviewerFocus: [],
        },
        risks: [],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("## Summary");
    expect(result.mainComment).toContain(
      "## Summary\n\n**No exploitable security path found**\n\n| Status | Max severity | Risks |",
    );
    expect(result.mainComment).toContain("**No exploitable security path found**");
    expect(result.mainComment).toContain("| Status | Max severity | Risks |");
    expect(result.mainComment).toContain("| Pass | None | 0 |");
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
    expect(result.mainComment).toContain("| Fail | High | 1 |");
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

  it("does not fail Security SAST for a high risk with an invalid diff anchor", async () => {
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
          headline: "Security review completed",
          riskSummary: "One model risk did not map to changed code.",
          reviewerFocus: [],
        },
        risks: [
          {
            title: "Unanchored privileged path",
            category: "auth",
            severity: "high",
            rationale: "The reported path is not present in the diff.",
            finding: {
              body: "This should not affect the required check.",
              path: "src/missing.ts",
              rangeId: "missing-range",
              side: "RIGHT",
              startLine: 99,
              endLine: 99,
            },
          },
        ],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).not.toContain("Unanchored privileged path");
    expect(result.mainComment).toContain("Omitted 1 risk with an invalid or duplicate anchor.");
    expect(result.inlineCommentDrafts).toEqual([]);
    expect(result.taskChecks).toContainEqual({
      taskName: "security-sast",
      conclusion: "success",
      summary: "No high or critical security risks found.",
    });
  });

  it("keeps the highest-severity duplicate before deriving the Security SAST check", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-security-sast-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "security-sast",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const finding = {
      body: "This guard accepts issue comments without proving the actor is trusted.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
    };

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: jsonPiRunner({
        summary: {
          headline: "Privileged path needs review",
          riskSummary: "Duplicate model risks disagree on severity.",
          reviewerFocus: [],
        },
        risks: [
          {
            title: "Low-severity interpretation",
            category: "auth",
            severity: "low",
            rationale: "The first duplicate understates the impact.",
            finding,
          },
          {
            title: "High-severity interpretation",
            category: "auth",
            severity: "high",
            rationale: "The changed guard reaches a privileged workflow.",
            finding,
          },
        ],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("| Fail | High | 1 |");
    expect(result.mainComment).toContain("High-severity interpretation");
    expect(result.mainComment).not.toContain("Low-severity interpretation");
    expect(result.mainComment).toContain("Omitted 1 risk with an invalid or duplicate anchor.");
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
    expect(configTs).toContain("fixVerificationOutput");
    expect(configTs).toContain("isPublishableSuggestion");
    expect(configTs).toContain("isPublishableSuggestedFixSelection");
    expect(configTs).toContain("suggestionIncludesUnselectedContext");
    expect(configTs).toContain("onlyChangesWhitespace");
    expect(configTs).toContain("suggestionIntroducesNewEnvironmentAccess");
    expect(configTs).toContain("structuralEdgeToken");
    expect(configTs).toContain('"{}[]()<>".includes(char)');
    expect(configTs).toContain(String.raw`].join("\n")`);
    expect(configTs).toContain("scanCodeWhitespace");
    expect(configTs).toContain(String.raw`/\s/.test(char)`);
    expect(configTs).toContain(String.raw`/\b(?:process|Bun|import\.meta)`);
    expect(configTs).not.toContain(String.raw`/\\s/.test(char)`);
    expect(configTs).not.toContain(String.raw`/\\b(?:process|Bun|import\\.meta)`);
    expect(configTs).toContain("@pipr improve");
    expect(configTs).toContain("maxInlineComments: 6");
    expect(inspected.agents).toContain("fix-suggestions");
    expect(inspected.agents).toContain("fix-suggestion-verifier");
    expect(inspected.tasks).toContain("fix-suggestions");
    expect(inspected.commands).toContainEqual({
      pattern: "@pipr improve",
      task: "fix-suggestions",
      permission: "write",
    });

    const manifest = reviewTestManifest();
    const sourceFile = manifest.files[0];
    if (!sourceFile) {
      throw new Error("fix-suggestions test fixture missing source file");
    }
    const sourceRange = sourceFile.commentableRanges[0];
    if (!sourceRange) {
      throw new Error("fix-suggestions test fixture missing source range");
    }
    const literalManifest = {
      ...manifest,
      files: [
        {
          ...sourceFile,
          commentableRanges: [
            { ...sourceRange, preview: 'const header = "Bearer" + token;' },
            {
              ...sourceRange,
              id: "range-regex",
              startLine: 30,
              endLine: 30,
              preview: "return /ab/;",
            },
            {
              ...sourceRange,
              id: "range-template",
              startLine: 40,
              endLine: 40,
              preview: "const label = `$" + "{first + last}`;",
            },
            {
              ...sourceRange,
              id: "range-structural",
              startLine: 50,
              endLine: 51,
              preview: ["{", "return value;"].join("\n"),
            },
            {
              ...sourceRange,
              id: "range-token-separator",
              startLine: 60,
              endLine: 60,
              preview: "returnvalue;",
            },
            {
              ...sourceRange,
              id: "range-regex-statement",
              startLine: 70,
              endLine: 70,
              preview: "if (ok) /ab/.test(value);",
            },
            {
              ...sourceRange,
              id: "range-comment",
              startLine: 80,
              endLine: 80,
              preview: "// Join firstand last name",
            },
            {
              ...sourceRange,
              id: "range-url-literal",
              startLine: 90,
              endLine: 90,
              preview: 'const endpoint = "https://example.com";',
            },
            {
              ...sourceRange,
              id: "range-regex-comment-like",
              startLine: 100,
              endLine: 100,
              preview: "const pattern = /[/*]/;",
            },
          ],
        },
      ],
    };
    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      taskName: "fix-suggestions",
      commandInvocation: {
        name: "improve",
        line: "@pipr improve",
        arguments: {},
        sourceCommentId: "123",
      },
      diffManifestBuilder: () => literalManifest,
      piRunner: sequentialJsonPiRunner([
        {
          suggestions: [
            {
              title: "Bearer scheme is missing its separator",
              category: "correctness",
              body: "The token is concatenated directly onto the authentication scheme.",
              path: "src/a.ts",
              rangeId: "range-1",
              side: "RIGHT",
              startLine: 10,
              endLine: 10,
              suggestedFix: 'const header = "Bearer " + token;',
            },
            {
              title: "Regex requires a literal separator",
              category: "correctness",
              body: "The pattern currently accepts only adjacent characters.",
              path: "src/a.ts",
              rangeId: "range-regex",
              side: "RIGHT",
              startLine: 30,
              endLine: 30,
              suggestedFix: "return /a b/;",
            },
            {
              title: "Keyword requires a token separator",
              category: "correctness",
              body: "The merged token is not a return statement.",
              path: "src/a.ts",
              rangeId: "range-token-separator",
              side: "RIGHT",
              startLine: 60,
              endLine: 60,
              suggestedFix: "return value;",
            },
            {
              title: "Regex statement requires a literal separator",
              category: "correctness",
              body: "The expression statement pattern currently matches adjacent characters.",
              path: "src/a.ts",
              rangeId: "range-regex-statement",
              side: "RIGHT",
              startLine: 70,
              endLine: 70,
              suggestedFix: "if (ok) /a b/.test(value);",
            },
            {
              title: "Comment wording requires a separator",
              category: "documentation",
              body: "The comment currently merges two words.",
              path: "src/a.ts",
              rangeId: "range-comment",
              side: "RIGHT",
              startLine: 80,
              endLine: 80,
              suggestedFix: "// Join first and last name",
            },
            {
              title: "URL literal formatting only",
              category: "maintainability",
              body: "This changes only code whitespace around a URL literal.",
              path: "src/a.ts",
              rangeId: "range-url-literal",
              side: "RIGHT",
              startLine: 90,
              endLine: 90,
              suggestedFix: 'const  endpoint = "https://example.com";',
            },
            {
              title: "Regex literal formatting only",
              category: "maintainability",
              body: "This changes only code whitespace around a regex literal.",
              path: "src/a.ts",
              rangeId: "range-regex-comment-like",
              side: "RIGHT",
              startLine: 100,
              endLine: 100,
              suggestedFix: "const  pattern = /[/*]/;",
            },
            {
              title: "Identical replacement",
              category: "maintainability",
              body: "This does not change the selected line.",
              path: "src/a.ts",
              rangeId: "range-1",
              side: "RIGHT",
              startLine: 10,
              endLine: 10,
              suggestedFix: 'const header = "Bearer" + token;',
            },
            {
              title: "Formatting-only replacement",
              category: "maintainability",
              body: "This changes only code whitespace.",
              path: "src/a.ts",
              rangeId: "range-1",
              side: "RIGHT",
              startLine: 10,
              endLine: 10,
              suggestedFix: 'const  header = "Bearer" + token;',
            },
            {
              title: "Invented environment key",
              category: "correctness",
              body: "This introduces configuration not present in the diff.",
              path: "src/a.ts",
              rangeId: "range-1",
              side: "RIGHT",
              startLine: 10,
              endLine: 10,
              suggestedFix: "const header = process.env.NEW_BEARER_TOKEN;",
            },
            {
              title: "Template expression formatting",
              category: "maintainability",
              body: "This changes only expression whitespace.",
              path: "src/a.ts",
              rangeId: "range-template",
              side: "RIGHT",
              startLine: 40,
              endLine: 40,
              suggestedFix: "const label = `$" + "{first+last}`;",
            },
            {
              title: "Structural edge replacement",
              category: "correctness",
              body: "This replaces the opening structural edge.",
              path: "src/a.ts",
              rangeId: "range-structural",
              side: "RIGHT",
              startLine: 50,
              endLine: 51,
              suggestedFix: ["}", "return nextValue;"].join("\n"),
            },
          ],
        },
        {
          verdicts: [0, 1, 2, 3, 4].map((index) => ({
            index,
            accepted: true,
            reason: "The exact replacement matches the stated defect.",
          })),
        },
      ]),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("Bearer scheme is missing its separator");
    expect(result.mainComment).toContain("Regex requires a literal separator");
    expect(result.mainComment).toContain("Keyword requires a token separator");
    expect(result.mainComment).toContain("Regex statement requires a literal separator");
    expect(result.mainComment).toContain("Comment wording requires a separator");
    expect(result.mainComment).not.toContain("Identical replacement");
    expect(result.mainComment).not.toContain("Formatting-only replacement");
    expect(result.mainComment).not.toContain("Invented environment key");
    expect(result.mainComment).not.toContain("Template expression formatting");
    expect(result.mainComment).not.toContain("Structural edge replacement");
    expect(result.mainComment).not.toContain("URL literal formatting only");
    expect(result.mainComment).not.toContain("Regex literal formatting only");
    expect(result.inlineCommentDrafts.map((draft) => draft.finding.suggestedFix)).toEqual(
      expect.arrayContaining(['const header = "Bearer " + token;', "return /a b/;"]),
    );
  });

  it("publishes only semantically accepted fix suggestions", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-fix-suggestions-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "fix-suggestions",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    let piCalls = 0;
    const suggestion = (title: string, suggestedFix: string) => ({
      title,
      category: "correctness",
      body: "This exact replacement addresses the changed defect.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
      suggestedFix,
    });

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      taskName: "fix-suggestions",
      commandInvocation: {
        name: "improve",
        line: "@pipr improve",
        arguments: {},
        sourceCommentId: "123",
      },
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: sequentialJsonPiRunner(
        [
          {
            suggestions: [
              suggestion("Accepted fix", "return safeValue;"),
              suggestion("Rejected fix", "throw new Error();"),
            ],
          },
          {
            verdicts: [
              { index: 0, accepted: true, reason: "The replacement fixes the stated defect." },
              { index: 1, accepted: false, reason: "The replacement changes unrelated behavior." },
              { index: 1, accepted: true, reason: "Duplicate verdict." },
              { index: 9, accepted: true, reason: "Invented index." },
            ],
          },
        ],
        () => {
          piCalls += 1;
        },
      ),
    });

    assertReviewResult(result);
    expect(piCalls).toBe(2);
    expect(result.mainComment).toContain("1 exact suggested change passed validation.");
    expect(result.mainComment).toContain("Accepted fix");
    expect(result.mainComment).not.toContain("Rejected fix");
    expect(result.inlineCommentDrafts).toHaveLength(1);
  });

  it("skips fix verification without deterministic candidates and handles all rejected output", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-fix-suggestions-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "fix-suggestions",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    let emptyCalls = 0;
    const emptyResult = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      taskName: "fix-suggestions",
      commandInvocation: {
        name: "improve",
        line: "@pipr improve",
        arguments: {},
        sourceCommentId: "123",
      },
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: sequentialJsonPiRunner([{ suggestions: [] }], () => {
        emptyCalls += 1;
      }),
    });

    assertReviewResult(emptyResult);
    expect(emptyCalls).toBe(1);
    expect(emptyResult.mainComment).toContain("No exact suggested changes passed validation.");

    const rejectedResult = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      taskName: "fix-suggestions",
      commandInvocation: {
        name: "improve",
        line: "@pipr improve",
        arguments: {},
        sourceCommentId: "124",
      },
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: sequentialJsonPiRunner([
        {
          suggestions: [
            {
              title: "Rejected fix",
              category: "correctness",
              body: "The candidate is semantically unsafe.",
              path: "src/a.ts",
              rangeId: "range-1",
              side: "RIGHT",
              startLine: 10,
              endLine: 10,
              suggestedFix: "return safeValue;",
            },
          ],
        },
        {
          verdicts: [{ index: 0, accepted: false, reason: "The patch changes the contract." }],
        },
      ]),
    });

    assertReviewResult(rejectedResult);
    expect(rejectedResult.mainComment).toContain("No exact suggested changes passed validation.");
    expect(rejectedResult.mainComment).not.toContain("Rejected fix");
    expect(rejectedResult.inlineCommentDrafts).toEqual([]);
  });

  it("fails closed on malformed fix suggestion verifier output", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-fix-suggestions-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "fix-suggestions",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const malformedVerifierOutput = {
      verdicts: [{ index: "0", accepted: true, reason: "The index has the wrong type." }],
    };

    await expect(
      runTaskRuntime({
        workspace: rootDir,
        config: project.settings.config,
        event: eventContext(),
        plan: project.plan,
        taskName: "fix-suggestions",
        commandInvocation: {
          name: "improve",
          line: "@pipr improve",
          arguments: {},
          sourceCommentId: "125",
        },
        diffManifestBuilder: () => reviewTestManifest(),
        piRunner: sequentialJsonPiRunner([
          {
            suggestions: [
              {
                title: "Candidate fix",
                category: "correctness",
                body: "The exact replacement addresses the changed defect.",
                path: "src/a.ts",
                rangeId: "range-1",
                side: "RIGHT",
                startLine: 10,
                endLine: 10,
                suggestedFix: "return safeValue;",
              },
            ],
          },
          malformedVerifierOutput,
          malformedVerifierOutput,
        ]),
      }),
    ).rejects.toThrow("schema validation");
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

  it("deduplicates quality gate blockers before rendering and concluding the check", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-quality-gate-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "quality-gate",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const blocker = {
      title: "Request fallback is skipped",
      category: "correctness",
      impact: "Requests can fail instead of using the fallback.",
      body: "This returns before the fallback can run.",
      path: "src/a.ts",
      rangeId: "range-1",
      side: "RIGHT",
      startLine: 10,
      endLine: 10,
    };

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: jsonPiRunner({ summary: "One blocker found.", blockers: [blocker, blocker] }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("| Fail | 1 | Correctness (1) |");
    expect(result.mainComment).toContain(
      "1 model-reported blocker was ignored because it does not match a commentable diff range or duplicates another blocker.",
    );
    expect(result.inlineCommentDrafts).toHaveLength(1);
    expect(result.taskChecks).toContainEqual({
      taskName: "quality-gate",
      conclusion: "failure",
      summary: "1 blocking quality issue found.",
    });
  });

  it("reports PR hygiene attention as neutral and omits invalid inline findings", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-pr-hygiene-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "pr-hygiene",
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
        summary: "Tests need attention.",
        checks: [
          { policy: "tests", status: "attention", evidence: "Behavior changed without a test." },
          { policy: "docs", status: "not-applicable", evidence: "No public docs changed." },
          { policy: "lockfiles", status: "not-applicable", evidence: "No lockfiles changed." },
          {
            policy: "generated-files",
            status: "not-applicable",
            evidence: "No generated files changed.",
          },
          { policy: "change-size", status: "pass", evidence: "One source file changed." },
        ],
        findings: [
          {
            title: "Invented hygiene anchor",
            policy: "tests",
            body: "This should not be rendered.",
            path: "src/missing.ts",
            rangeId: "missing-range",
            side: "RIGHT",
            startLine: 99,
            endLine: 99,
          },
        ],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).not.toContain("Invented hygiene anchor");
    expect(result.mainComment).not.toContain("**Findings:**");
    expect(result.mainComment).not.toContain("Omitted 1 finding");
    expect(result.inlineCommentDrafts).toEqual([]);
    expect(result.taskChecks).toContainEqual({
      taskName: "pr-hygiene",
      conclusion: "neutral",
      summary: "1 hygiene check needs attention.",
    });
  });

  it("rejects duplicate or missing PR hygiene policy verdicts", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-pr-hygiene-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "pr-hygiene",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });

    await expect(
      runTaskRuntime({
        workspace: rootDir,
        config: project.settings.config,
        event: eventContext(),
        plan: project.plan,
        diffManifestBuilder: () => reviewTestManifest(),
        piRunner: jsonPiRunner({
          summary: "Hygiene review completed.",
          checks: [
            { policy: "tests", status: "pass", evidence: "Tests changed." },
            { policy: "tests", status: "pass", evidence: "Duplicate tests verdict." },
            { policy: "lockfiles", status: "not-applicable", evidence: "No lockfiles." },
            {
              policy: "generated-files",
              status: "not-applicable",
              evidence: "No generated files.",
            },
            { policy: "change-size", status: "pass", evidence: "One source file." },
          ],
          findings: [],
        }),
      }),
    ).rejects.toThrow("schema validation");
  });

  it("filters invalid diff diagnostics before publication", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-diff-diagnostics-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "diff-diagnostics",
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
        summary: "Diagnostics completed.",
        diagnostics: [
          {
            body: "This diagnostic has no changed-code anchor.",
            path: "src/missing.ts",
            rangeId: "missing-range",
            side: "RIGHT",
            startLine: 99,
            endLine: 99,
          },
        ],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("Diagnostics completed.");
    expect(result.mainComment).not.toContain("**Findings:**");
    expect(result.mainComment).not.toContain("Omitted 1 diagnostic");
    expect(result.inlineCommentDrafts).toEqual([]);
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

  it("gives the multi-agent aggregator diff context for independent revalidation", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-multi-agent-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "multi-agent-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    let aggregatorPrompt = "";
    let aggregatorTools: unknown;
    const reviewOutput = {
      summary: { body: "No actionable findings." },
      inlineFindings: [],
    };

    const result = await runTaskRuntime({
      workspace: rootDir,
      config: project.settings.config,
      event: eventContext(),
      plan: project.plan,
      diffManifestBuilder: () => reviewTestManifest(),
      piRunner: async (run) => {
        if (run.prompt.includes("## Specialist results")) {
          aggregatorPrompt = run.prompt;
          aggregatorTools = run.builtinTools;
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify(reviewOutput),
          stderr: "",
          durationMs: 1,
        };
      },
    });

    assertReviewResult(result);
    expect(aggregatorPrompt).toContain("Diff Manifest:");
    expect(aggregatorPrompt).toContain("independently revalidate");
    expect(aggregatorTools).toEqual(expect.arrayContaining(["read", "grep", "find", "ls"]));
  });

  it("renders diagnosed and insufficient-context CI triage responses", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-ci-triage-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "ci-triage-command",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const runTriage = (output: unknown, sourceCommentId: number) =>
      runTaskRuntime({
        workspace: rootDir,
        config: project.settings.config,
        event: eventContext(),
        plan: project.plan,
        taskName: "ci-triage",
        taskInput: { log: "error: test process exited with code 1" },
        commandInvocation: {
          name: "ci",
          line: "@pipr ci error: test process exited with code 1",
          arguments: { log: "error: test process exited with code 1" },
          sourceCommentId: String(sourceCommentId),
        },
        diffManifestBuilder: () => reviewTestManifest(),
        piRunner: jsonPiRunner(output),
      });

    const diagnosed = await runTriage(
      {
        status: "diagnosed",
        summary: "The first test command failed before later jobs were cancelled.",
        evidence: ["The test process is the first command with a non-zero exit."],
        likelyCauses: ["The changed request branch violates the asserted return contract."],
        nextSteps: ["Run the failing test file locally."],
      },
      201,
    );
    if (diagnosed.kind !== "command-response") {
      throw new Error("expected a CI triage command response");
    }
    expect(diagnosed.commandResponse.body).toContain("**Status:** Diagnosed");
    expect(diagnosed.commandResponse.body).toContain("## Evidence");
    expect(diagnosed.commandResponse.body).toContain("## Likely Causes");
    expect(diagnosed.commandResponse.body).toContain("## Next Steps");

    const insufficient = await runTriage(
      {
        status: "insufficient-context",
        summary: "The excerpt contains only a final exit code.",
        evidence: ["No failing command or stack trace is present."],
        likelyCauses: [],
        nextSteps: ["Provide the log beginning at the first failing command."],
      },
      202,
    );
    if (insufficient.kind !== "command-response") {
      throw new Error("expected a CI triage command response");
    }
    expect(insufficient.commandResponse.body).toContain("**Status:** Insufficient context");
    expect(insufficient.commandResponse.body).not.toContain("## Likely Causes");
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
    expect(configTs).toContain("Return empty arrays for list sections with no useful content");
    expect(configTs).not.toContain('"```mermaid",\n    diagram,\n    "```"');
  });

  it("omits empty optional PR briefing sections", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-pr-briefing-"));

    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "pr-briefing",
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
        summary: "Changes request handling without altering public behavior.",
        prType: "refactor",
        riskLevel: "low",
        riskSummary: "The implementation and caller remain coordinated.",
        changeMap: [],
        reviewerFocus: [],
        notableFiles: [],
        walkthrough: [],
      }),
    });

    assertReviewResult(result);
    expect(result.mainComment).toContain("## Summary");
    expect(result.mainComment).not.toContain("## Change Map");
    expect(result.mainComment).not.toContain("## Reviewer Focus");
    expect(result.mainComment).not.toContain("## Notable Files");
    expect(result.mainComment).not.toContain("## Walkthrough");
  });

  it("generates grounded recipe policies and expanded dependency scopes", async () => {
    const recipeConfigs = new Map<string, string>();
    for (const recipe of [
      "dependency-risk",
      "plugin-tool-review",
      "interactive-ask",
      "changelog-draft",
    ] as const) {
      const rootDir = await mkdtemp(path.join(os.tmpdir(), `pipr-init-${recipe}-`));
      await initOfficialMinimalProject({ rootDir, adapters: [], recipe, minimal: true });
      recipeConfigs.set(recipe, await Bun.file(path.join(rootDir, ".pipr", "config.ts")).text());
    }

    const dependencyConfig = recipeConfigs.get("dependency-risk") ?? "";
    for (const dependencyFile of [
      "deno.json",
      "deno.jsonc",
      "jsr.json",
      "uv.lock",
      "poetry.lock",
      "Pipfile",
      "Pipfile.lock",
      "Gemfile",
      "Gemfile.lock",
      "composer.json",
      "composer.lock",
      "Package.swift",
      "Package.resolved",
      "Directory.Packages.props",
      "packages.lock.json",
    ]) {
      expect(dependencyConfig).toContain(`**/${dependencyFile}`);
    }
    expect(dependencyConfig).toContain("z.array(z.string()).max(6)");
    expect(recipeConfigs.get("plugin-tool-review")).toContain("based only on memory");
    expect(recipeConfigs.get("interactive-ask")).toContain("Distinguish evidence from inference");
    expect(recipeConfigs.get("changelog-draft")).toContain("Do not invent issue IDs");
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
      "uses: somus/pipr@v0.4.2", // x-release-please-version
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
    expect(pipeline).toContain("ghcr.io/somus/pipr:v0.4.2"); // x-release-please-version
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

function sequentialJsonPiRunner(outputs: unknown[], onCall?: () => void): PiRunner {
  let index = 0;
  return async () => {
    onCall?.();
    const output = outputs[index];
    index += 1;
    return {
      exitCode: 0,
      stdout: JSON.stringify(output ?? {}),
      stderr: "",
      durationMs: 1,
    };
  };
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
