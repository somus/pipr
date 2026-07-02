import type { OfficialInitRecipe } from "./types.js";

export const prBriefingRecipe = {
  id: "pr-briefing",
  title: "PR Briefing",
  description: "PR-Agent describe-style overview, risk summary, and walkthrough.",
  sourceTools: ["PR-Agent /describe", "CodeRabbit PR summaries"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "medium" },
  });

  pipr.config({ publication: { maxInlineComments: 0 } });

  pipr.review({
    id: "pr-briefing",
    model,
    instructions: \`
      Produce a maintainer briefing instead of a defect hunt. Summarize what changed,
      classify the PR type, explain review risk, and include a concise file walkthrough.
      Return no inline findings unless there is a concrete blocker.
    \`,
    comment: (result, context) => [
      "## PR Briefing",
      "",
      \`**Change:** \${context.change.title}\`,
      "",
      result.summary.body,
      "",
      "\`\`\`mermaid",
      "flowchart LR",
      "  A[Changed files] --> B[Review focus]",
      "  B --> C[Merge decision]",
      "\`\`\`",
    ].join("\\n"),
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: { pattern: "@pipr describe", permission: "read" },
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
