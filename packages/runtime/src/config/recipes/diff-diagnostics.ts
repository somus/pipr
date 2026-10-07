import type { OfficialInitRecipe } from "./types.js";

export const diffDiagnosticsRecipe = {
  id: "diff-diagnostics",
  title: "Diff Diagnostics",
  description: "reviewdog-style diagnostic review mapped into inline findings.",
  sourceTools: ["reviewdog"],
  configTs: `import { definePipr, md, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });
  const diagnostic = pipr.finding({});

  const diagnostics = pipr.agent({
    name: "diff-diagnostics",
    model,
    instructions: \`
      Produce short compiler-style diagnostics for actionable defects only.
      State the concrete defect and impact in at most two sentences. Suppress
      style preferences, broad refactors, and diagnostics without exact changed-line anchors.
    \`,
    output: z.strictObject({ summary: z.string(), diagnostics: z.array(diagnostic) }),
    prompt: () => "Summarize the diff-scoped diagnostics for this change.",
  });

  pipr.task({
    name: "diff-diagnostics",
    on: {
      changeRequest: ["opened", "updated"],
      command: { pattern: "@pipr diagnostics", permission: "write" },
    },
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true });
      const result = await ctx.pi.run(diagnostics, { diff });
      const { findings } = ctx.review.select(result.diagnostics);
      await ctx.comment({
        main: md.blocks(md\`## 🧭 Summary\`, md\`\${result.summary}\`),
        inlineFindings: findings,
      });
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
