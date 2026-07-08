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
    options: { thinking: "high" },
  });

  const dependencyOutput = pipr.schema({
    id: "dependency/risk-summary",
    schema: z.strictObject({
      summary: z.string(),
      risks: z.array(z.string()),
      followUps: z.array(z.string()),
    }),
  });

  const dependencyReviewer = pipr.agent({
    name: "dependency-risk",
    model,
    instructions: \`
      Review dependency manifest and lockfile changes. Flag likely breaking upgrades,
      suspicious package additions, install script risk, lockfile drift, and migration work.
      Do not claim live CVEs unless they are visible in the diff.
    \`,
    output: dependencyOutput,
    prompt: () => "Review the dependency-related changes in this pull request.",
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
          "**/Cargo.toml",
          "**/Cargo.lock",
          "**/go.mod",
          "**/go.sum",
        ],
      };
      const manifest = await ctx.change.diffManifest({ compressed: true, paths });
      if (manifest.files.length === 0) {
        await ctx.comment("No dependency files changed.");
        return;
      }
      const result = await ctx.pi.run(dependencyReviewer, { manifest }, { paths });
      await ctx.comment(
        [
          result.summary,
          "",
          "## Risks",
          ...result.risks.map((risk) => \`- \${risk}\`),
          "",
          "## Follow-ups",
          ...result.followUps.map((followUp) => \`- \${followUp}\`),
        ].join("\\n"),
      );
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated"], task });
  pipr.command({ pattern: "@pipr dependency-risk", permission: "write", task });
});
`,
} as const satisfies OfficialInitRecipe;
