import type { OfficialInitRecipe } from "./types.js";

export const interactiveAskRecipe = {
  id: "interactive-ask",
  title: "Interactive Ask",
  description: "PR-Agent ask-style free-form command over diff and prior review context.",
  sourceTools: ["PR-Agent /ask"],
  configTs: `import { definePipr, md } from "@usepipr/sdk";
import type { DiffContext, PriorReview } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

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
    prompt: (input: { question: string; diff: DiffContext; prior: PriorReview }) => pipr.prompt\`
      \${pipr.section("Question", input.question)}
      \${pipr.section("Prior pipr review", pipr.json(input.prior, { maxCharacters: 20000 }))}
    \`,
  });

  pipr.task<{ question: string }>({
    name: "interactive-ask",
    on: {
      command: {
        pattern: "@pipr ask <question...>",
        permission: "read",
        description: "Ask a question about this change request.",
        parse: (args) => ({ question: args.question ?? "" }),
      },
    },
    async run(ctx, input) {
      if (!ctx.command) {
        throw new Error("interactive-ask is a command-only task");
      }
      const diff = await ctx.change.diff({ compressed: true });
      const prior = await ctx.review.prior();
      const answer = await ctx.pi.run(askAgent, { question: input.question, diff, prior });
      await ctx.command.reply(md.blocks(md\`## ℹ️ Answer\`, md.raw(answer.body)));
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
