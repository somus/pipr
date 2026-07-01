import type { OfficialInitRecipe } from "./types.js";

export const ciTriageCommandRecipe = {
  id: "ci-triage-command",
  title: "CI Triage Command",
  description: "Command-only CI failure triage from a pasted log excerpt.",
  sourceTools: ["CodeRabbit"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const ciTriage = pipr.agent({
    name: "ci-triage",
    model,
    instructions: \`
      Explain likely causes for a CI failure using only the pasted log excerpt,
      pull request metadata, prior review state, and diff context. Be explicit when
      the log is insufficient.
    \`,
    output: pipr.schemas.summary,
    prompt: (input: { log: string; manifest: unknown; prior: unknown }) => pipr.prompt\`
      \${pipr.section("CI log excerpt", input.log)}
      \${pipr.section("Prior pipr review", pipr.json(input.prior, { maxCharacters: 20000 }))}
    \`,
  });

  const task = pipr.task<{ log: string }>({
    name: "ci-triage",
    async run(ctx, input) {
      if (!ctx.command) {
        throw new Error("ci-triage is a command-only task");
      }
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const prior = await ctx.review.prior();
      const result = await ctx.pi.run(ciTriage, { log: input.log, manifest, prior });
      await ctx.command.reply(\`## CI Triage\\n\\n\${result.body}\`);
    },
  });

  pipr.command({
    pattern: "@pipr ci <log...>",
    permission: "write",
    description: "Triage a pasted CI failure log.",
    parse: (args) => ({ log: args.log ?? "" }),
    task,
  });
});
`,
} as const satisfies OfficialInitRecipe;
