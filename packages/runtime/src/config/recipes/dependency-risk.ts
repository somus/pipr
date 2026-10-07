import type { OfficialInitRecipe } from "./types.js";

export const dependencyRiskRecipe = {
  id: "dependency-risk",
  title: "Dependency Risk",
  description: "Dependency manifest and lockfile review with Renovate-style risk notes.",
  sourceTools: ["Renovate"],
  configTs: `import { definePipr, md, z } from "@usepipr/sdk";

const dependencyPaths = {
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

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

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
    output: z.strictObject({
      summary: z.string(),
      risks: z.array(z.string()).max(6),
      followUps: z.array(z.string()).max(6),
    }),
    prompt: () => "Review the dependency-related changes in this change request.",
  });

  pipr.task({
    name: "dependency-risk",
    on: {
      changeRequest: ["opened", "updated"],
      command: { pattern: "@pipr dependency-risk", permission: "write" },
    },
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true, paths: dependencyPaths });
      if (diff.manifest.files.length === 0) {
        await ctx.comment(
          md.callout({
            icon: "ℹ️",
            title: "Dependency review skipped",
            body: "No dependency files changed.",
          }),
        );
        return;
      }
      const result = await ctx.pi.run(dependencyReviewer, { diff }, { paths: dependencyPaths });
      const riskCount = result.risks.length;
      await ctx.comment(
        md.blocks(
          riskCount === 0
            ? md.callout({ icon: "ℹ️", title: "Dependency review completed", body: "No observed risks." })
            : md.callout({
                icon: "⚠️",
                title: "Dependency risks observed",
                body: \`\${riskCount} \${riskCount === 1 ? "risk requires" : "risks require"} review.\`,
              }),
          md\`## 🧭 Summary\`,
          md\`\${result.summary}\`,
          riskCount > 0 ? md\`## ⚠️ Risks\` : "",
          md.list(result.risks),
          result.followUps.length > 0 ? md\`## 🛠️ Follow-ups\` : "",
          md.list(result.followUps),
        ),
      );
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
