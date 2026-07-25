import type { OfficialInitRecipe } from "./types.js";

export const interactiveAskRecipe = {
  id: "interactive-ask",
  title: "Interactive Ask",
  description: "PR-Agent ask-style free-form command over diff and prior review context.",
  sourceTools: ["PR-Agent /ask"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "high",
  });

  const askAgent = pipr.agent({
    name: "interactive-ask",
    model,
    instructions: \`
      Answer the reviewer question directly using the current diff, repository,
      and prior Pipr findings. Cite relevant paths or symbols when available.
      Distinguish evidence from inference. When external systems or hidden state
      are required, state precisely which missing context prevents an answer.
    \`,
    output: pipr.schemas.summary,
    prompt: (input: { question: string; manifest: unknown; prior: unknown }) => pipr.prompt\`
      \${pipr.section("Question", input.question)}
      \${pipr.section("Prior pipr review", pipr.json(input.prior, { maxCharacters: 20000 }))}
    \`,
  });

  const task = pipr.task<{ question: string }>({
    name: "interactive-ask",
    async run(ctx, input) {
      if (!ctx.command) {
        throw new Error("interactive-ask is a command-only task");
      }
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const prior = await ctx.review.prior();
      const answer = await ctx.pi.run(askAgent, { question: input.question, manifest, prior });
      await ctx.command.reply(answer.body);
    },
  });

  pipr.command({
    pattern: "@pipr ask <question...>",
    permission: "read",
    description: "Ask a question about this change request.",
    parse: (args) => ({ question: args.question ?? "" }),
    task,
  });
});
`,
} as const satisfies OfficialInitRecipe;
