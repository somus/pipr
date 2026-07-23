import { afterAll, afterEach, describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import { runTaskRuntime } from "../../review/task/task-runtime.js";
import { reviewTestManifest } from "../../tests/helpers/review-test-manifest.js";
import { inspectRuntimePlan, loadRuntimeProject, validateProject } from "../project.js";
import { listOfficialInitRecipes, supportedOfficialInitRecipes } from "../recipes.js";
import { initOfficialMinimalProjectWithLocalDependencies as initOfficialMinimalProject } from "./helpers/local-init-sdk.js";
import {
  assertReviewResult,
  cleanupTemporaryDirectories,
  configCoreInitFiles,
  eventContext,
  githubExpression,
  initializedConfigOnlyProject,
  jsonPiRunner,
  mkdtemp,
  packageInitFiles,
  recipeConfigFiles,
  sequentialJsonPiRunner,
  useLocalInitSdk,
} from "./init-fixtures.js";

afterAll(await useLocalInitSdk());
afterEach(cleanupTemporaryDirectories);

describe("initOfficialMinimalProject: generated recipes", () => {
  it("initializes every official recipe and validates the generated config", async () => {
    expect(supportedOfficialInitRecipes).not.toContain("deep-review");
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
    const pluginInspection = inspectRuntimePlan(pluginTool.plan, ".pipr/config.ts");
    expect(pluginInspection.tools).toEqual(["r2_memory_search", "r2_memory_store"]);
    expect(pluginInspection.commands).toEqual([
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
    expect(pluginConfig).toContain('import { memoryLimits, r2MemoryPlugin } from "./r2-memory";');
    expect(pluginConfig).not.toContain("new S3Client");
    expect(pluginConfig).not.toContain("memory.store.run");
    expect(pluginConfig).toContain("tools: [...pipr.tools.readOnly, memory.search]");
    expect(pluginConfig).toContain("await memory.curate(");
    expect(pluginMemory).toContain('import { S3Client } from "bun";');
    expect(pluginMemory).toContain("export const memoryLimits");
    expect(pluginMemory).toContain("subjectCharacters: 120");
    expect(pluginMemory).toContain("bodyCharacters: 4000");
    expect(pluginMemory).toContain("tagCount: 12");
    expect(pluginMemory).toContain("tagCharacters: 50");
    expect(pluginMemory).toContain("queryCharacters: 500");
    expect(pluginMemory).toContain("resultMinimum: 1");
    expect(pluginMemory).toContain("resultMaximum: 20");
    expect(pluginMemory).toContain("searchObjectMaximum: 2000");
    expect(pluginMemory).toContain("export function r2MemoryPlugin");
    expect(pluginMemory).toContain("crypto.randomUUID()");
    expect(pluginMemory).toContain("memoryStoreInput.parse(input)");
    expect(pluginMemory).toContain('sourceKind: "maintainer-command" | "agent-tool"');
    expect(pluginMemory).toContain("changeRequestNumber: ctx.change.number");
    expect(pluginMemory).toContain("curate(input: MemoryStoreInput, ctx: TaskContext");
    expect(pluginMemory).toContain("prefix: memoryPrefix(ctx, options) +");
    expect(pluginMemory).toContain("maxKeys: 200");
    expect(pluginMemory).toContain("continuationToken");
    expect(pluginMemory).toContain("listed.nextContinuationToken");
    expect(pluginMemory).toContain("scannedObjects < memoryLimits.searchObjectMaximum");
    expect(pluginMemory).toContain("skippedObjects: z.number().int().nonnegative()");
    expect(pluginMemory).toContain("skippedObjects += 1");
    expect(pluginMemory).toContain("skippedObjects,");
    expect(pluginMemory).toContain("[ctx.repository.owner, ctx.repository.name]");
    expect(pluginMemory).toContain("memoryKey(id, parsedInput.subject, ctx, options)");
    expect(pluginMemory).toContain('"/maintainer-command/"');
    expect(pluginMemory).toContain("encodeURIComponent(ctx.run.id)");
    expect(pluginMemory).toContain("await stableCommandMemoryId(ctx.run.id)");
    expect(pluginMemory).toContain("digest[6] = (digest[6]! & 0x0f) | 0x50");
    expect(inspectRuntimePlan(command.plan, ".pipr/config.ts").commands).toEqual([
      {
        pattern: "@pipr ask <question...>",
        task: "interactive-ask",
        permission: "read",
      },
    ]);
  });

  it("rejects invalid curated memory before storage or Pi execution", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-plugin-tool-"));
    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "plugin-tool-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    let piRuns = 0;
    const runRemember = (lesson: string, sourceCommentId: number) =>
      runTaskRuntime({
        workspace: rootDir,
        config: project.settings.config,
        event: eventContext(),
        plan: project.plan,
        taskName: "remember-review-memory",
        taskInput: { lesson },
        commandInvocation: {
          name: "remember",
          line: `@pipr remember ${lesson}`,
          arguments: { lesson },
          sourceCommentId: String(sourceCommentId),
        },
        diffManifestBuilder: () => reviewTestManifest(),
        piRunner: async () => {
          piRuns += 1;
          throw new Error("curated memory validation must not run Pi");
        },
      });

    const empty = await runRemember("   ", 301);
    const oversized = await runRemember("x".repeat(4001), 302);
    if (empty.kind !== "command-response" || oversized.kind !== "command-response") {
      throw new Error("expected curated memory command responses");
    }
    expect(empty.commandResponse.body).toBe("Usage: @pipr remember <lesson...>");
    expect(oversized.commandResponse.body).toBe(
      "Reviewer memory must be 4000 characters or fewer.",
    );
    expect(piRuns).toBe(0);
  });

  it("stores valid curated memory with stable identity and provenance", async () => {
    const rootDir = await mkdtemp(path.join(os.tmpdir(), "pipr-init-plugin-tool-"));
    await initOfficialMinimalProject({
      rootDir,
      adapters: [],
      recipe: "plugin-tool-review",
      minimal: true,
    });
    const project = await loadRuntimeProject({ rootDir });
    const writes: Array<{ path: string; body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        if (request.method !== "PUT") {
          return new Response("Method not allowed", { status: 405 });
        }
        writes.push({
          path: new URL(request.url).pathname,
          body: JSON.parse(await request.text()),
        });
        return new Response(null, { status: 200, headers: { ETag: '"test-etag"' } });
      },
    });
    const lesson = "Validate persisted reviewer guidance against the current diff.";
    const commandInvocation = {
      name: "remember",
      line: `@pipr remember ${lesson}`,
      arguments: { lesson },
      sourceCommentId: "401",
    } as const;
    const runRemember = () =>
      runTaskRuntime({
        workspace: rootDir,
        config: project.settings.config,
        event: eventContext(),
        plan: project.plan,
        taskName: "remember-review-memory",
        taskInput: { lesson },
        commandInvocation,
        env: {
          PIPR_R2_MEMORY_BUCKET: "memory-bucket",
          PIPR_R2_MEMORY_ENDPOINT: `http://127.0.0.1:${server.port}`,
          PIPR_R2_MEMORY_ACCESS_KEY_ID: "test-access-key",
          PIPR_R2_MEMORY_SECRET_ACCESS_KEY: "test-secret-key",
        },
        diffManifestBuilder: () => reviewTestManifest(),
        piRunner: async () => {
          throw new Error("curated memory storage must not run Pi");
        },
      });

    try {
      const first = await runRemember();
      const second = await runRemember();
      if (first.kind !== "command-response" || second.kind !== "command-response") {
        throw new Error("expected curated memory command responses");
      }
      const id = first.commandResponse.body.match(
        /^Stored reviewer memory `([0-9a-f-]{36})`\.$/,
      )?.[1];
      expect(id).toBeDefined();
      expect(second.commandResponse.body).toBe(first.commandResponse.body);
      expect(writes).toHaveLength(2);
      const firstWrite = writes[0];
      const secondWrite = writes[1];
      if (!firstWrite || !secondWrite) {
        throw new Error("expected two curated memory writes");
      }
      expect(firstWrite.path).toBe(
        `/memory-bucket/pipr-memory/local/pipr/maintainer-command/${encodeURIComponent(
          (firstWrite.body as { source: { runId: string } }).source.runId,
        )}.json`,
      );
      expect(secondWrite.path).toBe(firstWrite.path);
      expect(firstWrite.body).toEqual({
        id,
        subject: lesson,
        body: lesson,
        tags: ["maintainer-curated"],
        source: {
          kind: "maintainer-command",
          runId: expect.any(String),
          platform: "github",
          changeRequestNumber: 1,
          headSha: "head",
        },
        updatedAt: expect.any(String),
      });
      expect(secondWrite.body).toEqual({
        ...(firstWrite.body as object),
        updatedAt: expect.any(String),
      });
    } finally {
      server.stop(true);
    }
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
});
