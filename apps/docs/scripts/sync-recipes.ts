import { access, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listOfficialInitRecipes } from "../../../packages/runtime/src/config/recipes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../content/docs/recipes");
const publicDir = path.resolve(here, "../public");
const mode = process.argv.includes("--check") ? "check" : "sync";
const defaultWorkflowActionRef = "somus/pipr@v0.1.1"; // x-release-please-version

function starterWorkflow(recipe: (typeof recipes)[number]): string {
  const lines = [
    "name: pipr",
    "",
    "on:",
    "  pull_request:",
    "  issue_comment:",
    "    types: [created]",
    "  pull_request_review_comment:",
    "    types: [created]",
    "",
    "permissions:",
    "  contents: write",
    "  pull-requests: write",
    "  issues: write",
    "  checks: write",
    "",
    "jobs:",
    "  review:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v6",
    "        with:",
    "          fetch-depth: 0",
    `      - uses: ${defaultWorkflowActionRef} # x-release-please-version`,
    "        env:",
    `          DEEPSEEK_API_KEY: ${githubExpression("secrets.DEEPSEEK_API_KEY")}`,
    `          GITHUB_TOKEN: ${githubExpression("github.token")}`,
  ];

  for (const secret of recipe.workflowEnvSecrets ?? []) {
    lines.push(`          ${secret.env}: ${githubExpression(`secrets.${secret.secret}`)}`);
  }

  lines.push("");
  return lines.join("\n");
}

const recipes = listOfficialInitRecipes();
const expected = new Map<string, string>();
const recipeDescriptions = new Map([
  [
    "default-review",
    "Start with one general pull request reviewer that runs from change request events, `@pipr review`, and local `pipr review` while keeping inline comments bounded.",
  ],
  [
    "bug-hunter",
    "Focus Pipr on correctness defects, edge cases, race conditions, regressions, and missing tests with a reviewer tuned for actionable bug reports.",
  ],
  [
    "multi-agent-review",
    "Run specialist security, test, and maintainability agents, then merge their output through an aggregator into one concise pull request review.",
  ],
  [
    "pr-briefing",
    "Generate a PR-Agent describe-style overview that summarizes intent, changed areas, reviewer risks, and walkthrough notes as a main comment.",
  ],
  [
    "security-sast",
    "Review pull request changes for concrete security risks, severity, category, and attack path before publishing validated inline findings.",
  ],
  [
    "quality-gate",
    "Turn Pipr review output into a required quality check that fails when blocking correctness or test coverage risks are found.",
  ],
  [
    "diff-diagnostics",
    "Convert reviewdog-style diagnostics into Pipr inline findings so model output maps back to validated diff ranges.",
  ],
  [
    "pr-hygiene",
    "Check pull requests for operational hygiene such as tests, documentation updates, lockfile changes, generated files, and change size.",
  ],
  [
    "dependency-risk",
    "Review dependency manifest and lockfile changes for supply chain, versioning, licensing, and upgrade-risk signals.",
  ],
  [
    "ci-triage-command",
    "Add a command-only workflow that lets maintainers paste CI failure logs and get targeted triage without publishing normal review comments.",
  ],
  [
    "interactive-ask",
    "Add a free-form `@pipr` command that answers maintainer questions using the diff, prior Pipr review state, and bounded repository context.",
  ],
  [
    "plugin-tool-review",
    "Define a typed Pipr plugin with R2-backed memory search and store tools, then let reviewer agents recall durable project context across reviews.",
  ],
  [
    "changelog-draft",
    "Draft release-note style changelog entries from pull request changes and publish them as a command response comment.",
  ],
] satisfies Array<[string, string]>);

const recipeExpectedOutputs = new Map([
  [
    "default-review",
    "Pipr publishes one Main Review Comment and up to the configured number of Inline Review Comments. The same Review Task also runs from `@pipr review` and local `pipr review`.",
  ],
  [
    "bug-hunter",
    "Pipr publishes bug-focused review output with bounded inline comments. Use the command entrypoint when maintainers want to rerun the bug review on a risky pull request.",
  ],
  [
    "multi-agent-review",
    "Pipr runs specialist agents, asks the aggregator to dedupe their output, then publishes one review with one Main Review Comment and bounded Inline Review Comments.",
  ],
  [
    "pr-briefing",
    "Pipr publishes a Main Review Comment that orients reviewers with summary, risk framing, and walkthrough notes. It does not publish Inline Review Comments by default.",
  ],
  [
    "security-sast",
    "Pipr publishes security findings on valid diff ranges and fails the configured check for high or critical risks with a plausible attack path.",
  ],
  [
    "quality-gate",
    "Pipr publishes review output and a required quality check. The check is the merge signal when blocking findings are present.",
  ],
  [
    "diff-diagnostics",
    "Pipr maps structured diagnostics into validated Inline Review Comments and publishes dropped-finding metadata when a diagnostic cannot anchor to the diff.",
  ],
  [
    "pr-hygiene",
    "Pipr publishes pull-request hygiene feedback for tests, docs, lockfiles, generated files, and change size. Keep the check non-required until the policy is tuned.",
  ],
  [
    "dependency-risk",
    "Pipr reviews dependency manifests and lockfiles. If no matching dependency files changed, the task exits with a short Main Review Comment instead of spending model time.",
  ],
  [
    "ci-triage-command",
    "Pipr replies to the source command comment with CI triage. It does not publish normal review comments for this command-only workflow.",
  ],
  [
    "interactive-ask",
    "Pipr replies to the source command comment with an answer grounded in the current diff, prior Pipr review state, and bounded runtime context.",
  ],
  [
    "plugin-tool-review",
    "Pipr lets reviewer agents use the generated plugin tools during review, then publishes the normal review output from the task.",
  ],
  [
    "changelog-draft",
    "Pipr replies to the source command comment with a changelog draft. It does not edit changelog files.",
  ],
] satisfies Array<[string, string]>);

const recipeSampleOutputs = new Map(
  [
    "default-review",
    "bug-hunter",
    "security-sast",
    "quality-gate",
    "diff-diagnostics",
    "pr-hygiene",
    "dependency-risk",
    "multi-agent-review",
    "pr-briefing",
    "interactive-ask",
    "changelog-draft",
    "plugin-tool-review",
  ].map((recipeId) => [
    recipeId,
    {
      image: `/images/pipr/recipes/${recipeId}.png`,
    },
  ]),
);

const recipeNotes = new Map([
  [
    "default-review",
    `## Recipe notes

This is the baseline setup for repositories that want one trusted review path before adding specialist tasks. It uses \`pipr.review\`, so Pipr wires the change request and command entrypoints for you; local \`pipr review\` runs the same change-request task.

- Keep \`inlineComments.max\` low until the repository has enough review history to judge signal quality.
- Put repository-specific review policy in \`instructions\`, not in ad hoc task code.
- Use \`context.platform.id === "local"\` for text that appears only during local review.
- Add path filters only after you know which files must not receive inline findings.
`,
  ],
  [
    "bug-hunter",
    `## Recipe notes

Bug Hunter narrows review to likely defects and excludes Markdown/docs paths by default. It also declares a fallback model profile so transient or invalid output failures can retry without changing the task.

- Expand \`paths.exclude\` for generated files, snapshots, vendored code, or fixtures that produce noisy findings.
- Keep the command entrypoint \`@pipr bugs\` for manual reruns on risky PRs that did not need a full review.
- Tune the reviewer instructions around the bug classes your project sees: data loss, race conditions, migrations, API compatibility, or missed tests.
`,
  ],
  [
    "security-sast",
    `## Recipe notes

Security SAST uses a custom JSON Schema output instead of the default review schema. The task turns high and critical risks into a failed check and publishes only findings that include validated diff ranges.

- Keep severity rules concrete so the check fails only for risks with a plausible attack path.
- Add project-specific categories when the repository has important trust boundaries, such as tenant isolation, billing, or auth scopes.
- Treat this as pull-request SAST over changed code, not a replacement for dependency advisories or whole-repo scanners.
`,
  ],
  [
    "quality-gate",
    `## Recipe notes

Quality Gate makes Pipr part of the merge decision by publishing a required check. It also enables aggregate checks and tighter auto-resolve behavior for follow-up review state.

- Use this only when the reviewer instructions are strict enough to report merge-blocking issues rather than nice-to-have cleanup.
- Align the required check name with your branch protection rule before rolling it out broadly.
- Raise or lower \`publication.maxInlineComments\` based on how much blocking feedback maintainers can act on in one PR.
`,
  ],
  [
    "diff-diagnostics",
    `## Recipe notes

Diff Diagnostics models reviewdog-style output: the agent emits diagnostics, then the task maps each diagnostic into a Pipr \`ReviewFinding\`. This is useful when you want a custom intermediate schema but still need normal inline review comments.

- Keep the diagnostic schema small and deterministic so invalid-output repair stays cheap.
- Use \`suggestedFix\` only when the replacement is exact for the selected range.
- Add path filters to \`ctx.change.diffManifest(...)\` when diagnostics must apply to only one language or subsystem.
`,
  ],
  [
    "pr-hygiene",
    `## Recipe notes

PR Hygiene reviews the shape of the pull request: tests, docs, lockfiles, generated files, and size. It reads both \`changedFiles\` and the Diff Manifest so it can reason about file-level signals and changed code.

- Customize the instructions with your repository's release-note, migration, generated-code, and test expectations.
- Keep the check non-required until maintainers agree which hygiene findings must block merge.
- Add explicit allowlists for common mechanical changes, such as formatter-only PRs or dependency lockfile refreshes.
`,
  ],
  [
    "dependency-risk",
    `## Recipe notes

Dependency Risk scopes the Diff Manifest to package manifests and lockfiles before running the model. If no dependency files changed, the task exits with a short main comment instead of spending model time.

- Extend the include list for ecosystem-specific files, such as Helm charts, Docker base images, or Terraform provider locks.
- Ask for migration notes when your project frequently upgrades frameworks or runtime major versions.
- Do not rely on this recipe for live vulnerability lookup; the default prompt only claims risks visible in the diff.
`,
  ],
  [
    "ci-triage-command",
    `## Recipe notes

CI Triage is command-only. Maintainers paste the relevant log excerpt into \`@pipr ci <log...>\`, and Pipr replies in the command thread using the log, prior Pipr review state, and the current Diff Manifest.

- Keep the pasted log short enough to include the failing command, error, and nearby stack trace.
- Add CI-provider conventions to the instructions, such as test shard naming, cache keys, or known flaky suites.
- Keep the command permission at \`write\` if CI logs may contain internal paths, environment names, or deployment details.
`,
  ],
  [
    "multi-agent-review",
    `## Recipe notes

Multi-agent Review runs specialist agents for security, tests, and maintainability, then asks an aggregator to dedupe and publish one review. This costs more model work than the default recipe but gives each specialist a narrower job.

- Use it for larger or riskier repositories where one broad prompt misses important review dimensions.
- Keep specialist prompts independent, then put dedupe and prioritization rules in the aggregator.
- Watch timeout and token limits after adding specialists; each additional agent consumes a separate Pi run.
`,
  ],
  [
    "plugin-tool-review",
    `## Recipe notes

Plugin Tool Review demonstrates a typed Pipr plugin with R2-backed memory tools. The reviewer can call \`r2_memory_search\` while reviewing, and \`r2_memory_store\` is available for explicit customization when you decide what memory is safe to persist.

- Start with search-only reviewer behavior; add store calls only for curated, non-sensitive project knowledge.
- Keep the R2 bucket shared only when repository-scoped prefixes are acceptable for your organization.
- Add more plugin tools when the agent needs stable project context that must not be copied into every prompt.
`,
  ],
  [
    "pr-briefing",
    `## Recipe notes

PR Briefing is intentionally not a defect hunt. It disables inline comments and publishes a main-comment overview with change summary, risk framing, and a small walkthrough.

- Use this for repositories where reviewers first need orientation, not another blocking check.
- Keep the command permission at \`read\` when the briefing does not expose extra private systems.
- Replace the sample Mermaid block with repository-specific sections if maintainers prefer checklists, rollout notes, or ownership hints.
`,
  ],
  [
    "interactive-ask",
    `## Recipe notes

Interactive Ask is a read-permission command for maintainer questions. It answers from the current diff, prior Pipr review state, and bounded runtime context, and it must say when the answer needs external systems.

- Keep this separate from normal review so maintainers can ask follow-up questions without triggering new inline comments.
- Tighten the prompt if your team wants answers in a fixed format, such as risks, tests to run, or files to inspect.
- Raise command permission to \`write\` if answers could expose sensitive repository context.
`,
  ],
  [
    "changelog-draft",
    `## Recipe notes

Changelog Draft asks for one structured release-note entry and rationale. It publishes a comment only; it does not edit changelog files.

- Adjust the category enum to match your changelog taxonomy before relying on the output.
- Use it on release-facing repositories where maintainers routinely rewrite PR descriptions into notes.
- Keep the task comment-only unless you also add a separate, reviewed workflow for file edits.
`,
  ],
] satisfies Array<[string, string]>);

expected.set("index.mdx", renderIndex());
for (const recipe of recipes) {
  expected.set(`${recipe.id}.mdx`, renderRecipe(recipe));
}

await mkdir(docsDir, { recursive: true });

const existing = new Set((await readdir(docsDir)).filter((file) => file.endsWith(".mdx")));
let hasDrift = false;

for (const [file, content] of expected) {
  const target = path.join(docsDir, file);
  let current = "";
  try {
    current = await readFile(target, "utf8");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  if (current !== content) {
    if (mode === "check") {
      console.error(`Recipe docs drift: ${path.relative(process.cwd(), target)}`);
      hasDrift = true;
    } else {
      await writeFile(target, content);
    }
  }
  existing.delete(file);
}

for (const file of existing) {
  const target = path.join(docsDir, file);
  if (mode === "check") {
    console.error(`Unexpected recipe doc: ${path.relative(process.cwd(), target)}`);
    hasDrift = true;
  } else {
    await unlink(target);
  }
}

for (const sample of recipeSampleOutputs.values()) {
  const target = path.join(publicDir, sample.image.replace(/^\//, ""));
  try {
    await access(target);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }

    console.error(`Missing recipe sample image: ${path.relative(process.cwd(), target)}`);
    hasDrift = true;
  }
}

if (hasDrift) {
  console.error("Run `bun run --cwd apps/docs recipes:sync`.");
  process.exitCode = 1;
}

function renderIndex(): string {
  const cards = recipes
    .map(
      (recipe) =>
        `<Card title="${escapeAttribute(recipe.title)}" description="${escapeAttribute(
          recipeDescription(recipe),
        )}" href="/docs/recipes/${recipe.id}" />`,
    )
    .join("\n");

  return `---
title: "Recipes"
description: "Canonical starter configs generated by \`pipr init --recipe\`."
---

{/* This file is generated by apps/docs/scripts/sync-recipes.ts. */}

Recipes are checked-in starter configs for common review workflows. The code shown here is generated from Pipr's official runtime recipe registry, so it matches what \`pipr init\` writes.

\`\`\`bash
pipr init --recipe security-sast
pipr check
\`\`\`

Use \`pipr init\` without \`--recipe\` for the default review setup.

## Common setup

Every recipe follows the same setup path.

\`pipr init\` also writes \`.pipr/tsconfig.json\` and \`.pipr/types/**\` with generated Pipr SDK declarations for editor IntelliSense. These files are optional for CI and the GitHub Action; \`pipr check\` can synthesize the same SDK type support when they are missing.

\`\`\`bash
pipr init --recipe security-sast --no-types
pipr init --types-only
\`\`\`

Pipr config and plugin files execute in Bun, so \`.pipr/*.ts\` files can use the Bun API directly, including imports such as \`import { S3Client } from "bun"\`.

## Common tuning

Tune generated recipes in the config before changing runtime code.

- Change the model provider and \`apiKey\` secret name before committing the config.
- Run \`pipr inspect\` after edits to confirm models, tasks, commands, and tools.
- Use \`--adapters none\` when you want only the \`.pipr\` config files.
- Use a local run before opening a pull request when the recipe adds custom commands or tasks.
- Tune instructions first, then limits. Runtime limits are guardrails; prompts define what the reviewer treats as actionable.

## Recipe catalog

Choose the smallest recipe that matches the review workflow you want to try.

<Cards>
${cards}
</Cards>
`;
}

function renderRecipe(recipe: (typeof recipes)[number]): string {
  const command = recipe.id === "default-review" ? "pipr init" : `pipr init --recipe ${recipe.id}`;
  const files = recipeFiles(recipe);
  const fileTree = files.map((file) => ({ path: file.path }));
  const filePanes = files.map(renderRecipeFilePane).join("\n");
  const description = recipeDescription(recipe);
  const useCase = `${description.charAt(0).toLocaleLowerCase()}${description.slice(1)}`;
  const details = recipe.docsDetailsMdx ?? "";
  const notes = recipeNotes.get(recipe.id) ?? "";
  const sampleOutput = recipeSampleOutput(recipe);
  const extraSections = [sampleOutput, details, notes]
    .map((section) => section.trim())
    .filter(Boolean)
    .join("\n\n");

  return `---
title: "${escapeFrontmatter(recipe.title)}"
description: "${escapeFrontmatter(description)}"
---

{/* This file is generated by apps/docs/scripts/sync-recipes.ts. */}

This page shows the generated config for ${recipe.title}. The code matches what \`${command}\` writes.

## Use when

Use this recipe to ${useCase}

## Install

Install Pipr, generate the recipe, then validate the config:

\`\`\`bash
curl -fsSL https://raw.githubusercontent.com/somus/pipr/main/install.sh | sh
${command}
pipr check
\`\`\`

## Generated files

The recipe writes the config, any supporting \`.pipr\` files, and the GitHub workflow:

<RecipeFileExplorer files={${JSON.stringify(fileTree, null, 2)}}>
${filePanes}
</RecipeFileExplorer>

Use \`${command} --adapters none\` when you only want the \`.pipr\` config files.

## Expected output

${recipeExpectedOutput(recipe)}

${extraSections}

Shared setup, local type support, and provider tuning notes live on the [Recipes](/docs/recipes#common-setup) page.
`;
}

function recipeDescription(recipe: (typeof recipes)[number]): string {
  return recipeDescriptions.get(recipe.id) ?? recipe.description;
}

function recipeExpectedOutput(recipe: (typeof recipes)[number]): string {
  return (
    recipeExpectedOutputs.get(recipe.id) ??
    "Pipr publishes the review output configured by the generated `.pipr/config.ts`."
  );
}

function recipeSampleOutput(recipe: (typeof recipes)[number]): string {
  const sample = recipeSampleOutputs.get(recipe.id);
  if (!sample) {
    return "";
  }

  return `## Sample output

<img
  alt="${recipe.title} sample Pipr pull request output from github-actions bot"
  src="${sample.image}"
/>`;
}

function renderRecipeFilePane(file: { code: string; lang: string; path: string }): string {
  const fence = fenceFor(file.code);

  return `<RecipeFilePane path="${escapeAttribute(file.path)}">

${fence}${file.lang} title="${escapeAttribute(file.path)}"
${file.code.trimEnd()}
${fence}

</RecipeFilePane>`;
}

function fenceFor(value: string): string {
  const longest = Math.max(...[...value.matchAll(/`+/g)].map((match) => match[0].length), 2);
  return "`".repeat(longest + 1);
}

function recipeFiles(
  recipe: (typeof recipes)[number],
): Array<{ code: string; lang: string; path: string }> {
  return [
    { code: recipe.configTs, lang: "ts", path: ".pipr/config.ts" },
    ...(recipe.files ?? []).map((file) => ({
      code: file.contents,
      lang: recipeFileLanguage(file.relativePath),
      path: path.posix.join(".pipr", file.relativePath),
    })),
    { code: starterWorkflow(recipe), lang: "yaml", path: ".github/workflows/pipr.yml" },
  ];
}

function recipeFileLanguage(filePath: string): string {
  const extension = path.extname(filePath);
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".yaml" || extension === ".yml") {
    return "yaml";
  }
  return "ts";
}

function githubExpression(expression: string): string {
  return `$${["{{ ", expression, " }}"].join("")}`;
}

function escapeFrontmatter(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeAttribute(value: string): string {
  return escapeFrontmatter(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}
