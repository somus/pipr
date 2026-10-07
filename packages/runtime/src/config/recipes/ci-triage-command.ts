import type { OfficialInitRecipe } from "./types.js";

export const ciTriageCommandRecipe = {
  id: "ci-triage-command",
  title: "CI Triage Command",
  description: "Command-only CI failure triage from a pasted log excerpt.",
  sourceTools: ["CodeRabbit"],
  configTs: `import { definePipr, md, z } from "@usepipr/sdk";
import type { DiffContext, PriorReview } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  const ciTriage = pipr.agent({
    name: "ci-triage",
    model,
    instructions: \`
      Diagnose CI failures using only the pasted log excerpt, change request
      metadata, prior review state, and repository evidence. Identify the first
      actionable failure and separate it from downstream cascade errors. Use
      status "insufficient-context" when the excerpt cannot support a diagnosis.
      Do not infer a cause from a final exit code alone.
    \`,
    output: z.strictObject({
      status: z.enum(["diagnosed", "insufficient-context"]),
      summary: z.string(),
      evidence: z.array(z.string()).max(4),
      likelyCauses: z.array(z.string()).max(3),
      nextSteps: z.array(z.string()).max(4),
    }),
    prompt: (input: { log: string; diff: DiffContext; prior: PriorReview }) => pipr.prompt\`
      \${pipr.section("CI log excerpt", input.log)}
      \${pipr.section("Prior pipr review", pipr.json(input.prior, { maxCharacters: 20000 }))}
    \`,
  });

  pipr.task<{ log: string }>({
    name: "ci-triage",
    on: {
      command: {
        pattern: "@pipr ci <log...>",
        permission: "write",
        description: "Triage a pasted CI failure log.",
        parse: (args) => ({ log: args.log ?? "" }),
      },
    },
    async run(ctx, input) {
      if (!ctx.command) {
        throw new Error("ci-triage is a command-only task");
      }
      const diff = await ctx.change.diff({ compressed: true });
      const prior = await ctx.review.prior();
      const result = await ctx.pi.run(ciTriage, { log: input.log, diff, prior });
      await ctx.command.reply(
        md.blocks(
          result.status === "diagnosed"
            ? md.callout({
                icon: "ℹ️",
                title: "CI triage diagnosed",
                body: "An actionable failure was identified.",
              })
            : md.callout({
                icon: "ℹ️",
                title: "CI triage needs more context",
                body: "The excerpt does not support a diagnosis.",
              }),
          md\`## 🧭 Summary\`,
          md\`\${result.summary}\`,
          result.evidence.length > 0 ? md\`## Evidence\` : "",
          md.list(result.evidence),
          result.likelyCauses.length > 0 ? md\`## Likely Causes\` : "",
          md.list(result.likelyCauses),
          result.nextSteps.length > 0 ? md\`## 🛠️ Next Steps\` : "",
          md.list(result.nextSteps, { ordered: true }),
        ),
      );
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
