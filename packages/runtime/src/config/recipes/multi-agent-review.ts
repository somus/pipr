import type { OfficialInitRecipe } from "./types.js";

export const multiAgentReviewRecipe = {
  id: "multi-agent-review",
  title: "Multi-agent Review",
  description: "Security, test, and maintainability agents with an aggregator agent.",
  sourceTools: ["PR-Agent", "CodeRabbit", "GitHub Copilot code review"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const primary = pipr.model({
    id: "deepseek/deepseek-v4-pro-primary",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const fast = pipr.model({
    id: "deepseek/deepseek-v4-pro-fast",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "medium" },
  });

  const specialistPrompt = (input: { manifest: unknown; focus: string }) => pipr.prompt\`
    \${pipr.section("Focus", input.focus)}
  \`;

  const security = pipr.agent({
    name: "security-specialist",
    model: primary,
    instructions:
      "Report only exploitable security paths introduced or weakened by the change. Ignore non-security and style feedback.",
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: specialistPrompt,
  });
  const strictSecurity = security.extend({
    instructions: "Prioritize directly exploitable paths and suppress speculative findings.",
  });
  const tests = pipr.agent({
    name: "test-specialist",
    model: fast,
    instructions:
      "Report only meaningful regression gaps where changed behavior lacks evidence that would catch a concrete failure.",
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: specialistPrompt,
  });
  const maintainability = pipr.agent({
    name: "maintainability-specialist",
    model: primary,
    instructions:
      "Report only changed complexity, duplication, or brittle contracts that create a concrete correctness or reliability risk. Ignore cleanup preferences.",
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: specialistPrompt,
  });

  const aggregator = pipr.agent({
    name: "review-aggregator",
    model: primary,
    fallbacks: [fast],
    instructions: \`
      Merge specialist reviews into one concise review. Deduplicate findings,
      then independently revalidate changed-code causality, concrete impact,
      relevant contract and test context, and exact inline anchoring. Drop
      unsupported, conflicting, duplicate, speculative, or style-only items.
    \`,
    output: pipr.schemas.review,
    tools: pipr.tools.readOnly,
    prompt: (input: { manifest: unknown; specialistResults: unknown; prior: unknown }) => pipr.prompt\`
      \${pipr.section("Prior pipr review", pipr.json(input.prior, { maxCharacters: 20000 }))}
      \${pipr.section("Specialist results", pipr.json(input.specialistResults, { maxCharacters: 60000 }))}
    \`,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "6m",
  });

  const task = pipr.task({
    name: "multi-agent-review",
    check: { enabled: true, name: "multi-agent review", required: true },
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const prior = await ctx.review.prior();
      const [securityResult, testResult, maintainabilityResult] = await Promise.all([
        ctx.pi.run(strictSecurity, { manifest, focus: "security" }, { model: primary, fallbacks: [fast] }),
        ctx.pi.run(tests, { manifest, focus: "tests" }, { model: fast, fallbacks: [primary] }),
        ctx.pi.run(maintainability, { manifest, focus: "maintainability" }),
      ]);
      const result = await ctx.pi.run(aggregator, {
        manifest,
        specialistResults: { securityResult, testResult, maintainabilityResult },
        prior,
      });
      ctx.check.pass("Multi-agent review completed.");
      await ctx.comment({
        main: result.summary.body,
        inlineFindings: result.inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr multi", permission: "write", task });
});
`,
} as const satisfies OfficialInitRecipe;
