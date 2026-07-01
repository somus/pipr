import type { OfficialInitRecipe } from "./types.js";

export const qualityGateRecipe = {
  id: "quality-gate",
  title: "Quality Gate",
  description: "Required review check that fails on blocking correctness and test risks.",
  sourceTools: ["SonarQube"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.checks({
    aggregate: { enabled: true, name: "pipr quality gate" },
  });

  pipr.limits({
    timeoutSeconds: 420,
    diffManifest: {
      fullMaxEstimatedTokens: 32000,
      condensedMaxEstimatedTokens: 64000,
    },
  });

  pipr.config({
    publication: {
      maxInlineComments: 6,
      autoResolve: {
        enabled: true,
        model,
        instructions: "Resolve only when the changed code addresses the finding directly.",
        synchronize: true,
        userReplies: { enabled: true, allowedActors: "write" },
      },
    },
  });

  pipr.review({
    id: "quality-gate",
    model,
    instructions: \`
      Act as a merge quality gate. Report only blocking correctness,
      security, reliability, or test coverage issues that must prevent merge.
      If no blocking issue exists, state that no blocking issue exists.
    \`,
    check: { enabled: true, name: "quality gate", required: true },
    inlineComments: { max: 6 },
    comment: (result) => ({
      main: \`## Quality Gate\\n\\n\${result.summary.body}\`,
      inlineFindings: result.inlineFindings,
    }),
  });
});
`,
} as const satisfies OfficialInitRecipe;
