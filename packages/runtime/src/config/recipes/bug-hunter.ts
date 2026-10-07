import type { OfficialInitRecipe } from "./types.js";

export const bugHunterRecipe = {
  id: "bug-hunter",
  title: "Bug Hunter",
  description: "Bug-focused review for correctness, edge cases, races, and regressions.",
  sourceTools: ["Graphite AI Reviews", "CodeRabbit", "GitHub Copilot code review"],
  configTs: `import { defaultReviewActions, definePipr, md } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const primary = pipr.model("deepseek/deepseek-v4-pro", {
    id: "deepseek/deepseek-v4-pro-primary",
    thinking: "high",
  });
  const fallback = pipr.model("deepseek/deepseek-v4-pro", {
    id: "deepseek/deepseek-v4-pro-fast",
    thinking: "medium",
  });

  pipr.config({ publication: { maxInlineComments: 8 } });

  pipr.review({
    id: "bug-hunter",
    on: {
      changeRequest: defaultReviewActions,
      command: {
        pattern: "@pipr bugs",
        permission: "write",
        description: "Run a defect-focused review.",
      },
    },
    model: primary,
    fallbacks: [fallback],
    instructions: \`
      Review only defects with a reproducible failure path or a violated
      repository contract: broken logic, edge cases, concurrency risks, data
      loss, performance regressions, and behavior changes missing meaningful
      tests. For API, async, state, and concurrency changes, inspect relevant
      callers and tests before reporting. Suppress generic maintainability,
      style-only, and broad refactor feedback.
    \`,
    summary: {
      instructions: \`
        Summarize the changed behavior and concrete defect risk. Use the selected
        findings as evidence and omit generic praise or speculative concerns.
      \`,
    },
    paths: { exclude: ["docs/**", "**/*.md"] },
    timeout: "7m",
    render: ({ findings, summary }, context) => ({
      main: md.blocks(
        md\`## 🧭 Summary\`,
        summary?.body,
        findings.length > 0 ? md\`## ⚠️ Findings\` : "",
        findings.length === 0
          ? ""
          : context.run.trigger === "local"
            ? md.list(findings.map((finding) => finding.body))
            : "See inline comments in the diff.",
      ),
      inlineFindings: findings,
    }),
  });
});
`,
} as const satisfies OfficialInitRecipe;
