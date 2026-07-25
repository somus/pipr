import type { OfficialInitRecipe } from "./types.js";

export const bugHunterRecipe = {
  id: "bug-hunter",
  title: "Bug Hunter",
  description: "Bug-focused review for correctness, edge cases, races, and regressions.",
  sourceTools: ["Graphite AI Reviews", "CodeRabbit", "GitHub Copilot code review"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const primary = pipr.model({
    id: "deepseek/deepseek-v4-pro-primary",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "high",
  });

  const fallback = pipr.model({
    id: "deepseek/deepseek-v4-pro-fast",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "medium",
  });

  pipr.config({ publication: { maxInlineComments: 8 } });

  pipr.review({
    id: "bug-hunter",
    model: primary,
    fallbacks: [fallback],
    instructions: {
      findings: \`
        Review only defects with a reproducible failure path or a violated
        repository contract: broken logic, edge cases, concurrency risks, data
        loss, performance regressions, and behavior changes missing meaningful
        tests. For API, async, state, and concurrency changes, inspect relevant
        callers and tests before reporting. Suppress generic maintainability,
        style-only, and broad refactor feedback.
      \`,
      summary: \`
        Summarize the changed behavior and concrete defect risk. Use merged
        findings as evidence and omit generic praise or speculative concerns.
      \`,
    },
    paths: {
      exclude: ["docs/**", "**/*.md"],
    },
    timeout: "7m",
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: {
        pattern: "@pipr bugs",
        permission: "write",
        description: "Run a defect-focused review.",
      },
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
