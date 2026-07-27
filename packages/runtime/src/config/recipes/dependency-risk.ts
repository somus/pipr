import type { OfficialInitRecipe } from "./types.js";

export const dependencyRiskRecipe = {
  id: "dependency-risk",
  title: "Dependency Risk",
  description: "Dependency manifest and lockfile review with Renovate-style risk notes.",
  sourceTools: ["Renovate"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "high",
  });

  const dependencyOutput = pipr.schema({
    id: "dependency/risk-summary",
    schema: z.strictObject({
      summary: z.string(),
      risks: z.array(z.string()).max(6),
      followUps: z.array(z.string()).max(6),
    }),
  });

  const dependencyReviewer = pipr.agent({
    name: "dependency-risk",
    model,
    instructions: \`
      Review dependency manifest and lockfile changes. Distinguish direct from
      transitive changes, runtime from development scope, and manifest intent
      from generated lockfile churn. Check manifest-lock consistency. Flag
      evidenced breaking upgrades, suspicious additions, install script risk,
      lockfile drift, and required migration work. Do not make external release,
      compatibility, or CVE claims that are not evidenced in the change.
    \`,
    output: dependencyOutput,
    prompt: () => "Review the dependency-related changes in this change request.",
  });

  const task = pipr.task({
    name: "dependency-risk",
    async run(ctx) {
      const paths = {
        include: [
          "**/package.json",
          "**/bun.lock",
          "**/package-lock.json",
          "**/pnpm-lock.yaml",
          "**/yarn.lock",
          "**/requirements*.txt",
          "**/pyproject.toml",
          "**/deno.json",
          "**/deno.jsonc",
          "**/jsr.json",
          "**/uv.lock",
          "**/poetry.lock",
          "**/Pipfile",
          "**/Pipfile.lock",
          "**/Gemfile",
          "**/Gemfile.lock",
          "**/composer.json",
          "**/composer.lock",
          "**/Package.swift",
          "**/Package.resolved",
          "**/Directory.Packages.props",
          "**/packages.lock.json",
          "**/Cargo.toml",
          "**/Cargo.lock",
          "**/go.mod",
          "**/go.sum",
        ],
      };
      const manifest = await ctx.change.diffManifest({ compressed: true, paths });
      if (manifest.files.length === 0) {
        await ctx.comment("> ℹ️ **Dependency review skipped:** No dependency files changed.");
        return;
      }
      const result = await ctx.pi.run(dependencyReviewer, { manifest }, { paths });
      const sections = [
        dependencyOutcome(result.risks),
        "",
        "## 🧭 Summary",
        "",
        result.summary,
      ];
      if (result.risks.length > 0) {
        sections.push("", "## ⚠️ Risks", "", bulletList(result.risks));
      }
      if (result.followUps.length > 0) {
        sections.push("", "## 🛠️ Follow-ups", "", bulletList(result.followUps));
      }
      await ctx.comment(sections.join("\\n"));
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated"], task });
  pipr.command({ pattern: "@pipr dependency-risk", permission: "write", task });
});

function dependencyOutcome(risks: string[]): string {
  if (risks.length === 0) {
    return "> ℹ️ **Dependency review completed:** No observed risks.";
  }
  const noun = risks.length === 1 ? "risk requires" : "risks require";
  return \`> ⚠️ **Dependency risks observed:** \${risks.length} \${noun} review.\`;
}

function bulletList(items: string[]): string {
  return items.map((item) => \`- \${lineText(item)}\`).join("\\n");
}

function lineText(value: string): string {
  return value.replace(/\\r\\n?|\\n/g, " ").trim();
}
`,
} as const satisfies OfficialInitRecipe;
