import type { OfficialInitRecipe } from "./types.js";

export const defaultReviewRecipe = {
  id: "default-review",
  title: "Default Review",
  description: "General change request review with bounded inline comments.",
  sourceTools: ["pipr"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 5 } });

  pipr.review({
    id: "review",
    model,
    instructions: \`
      Review changed behavior for correctness, security, maintainability, and
      meaningful regression gaps. Focus on concrete impact and compatibility
      with repository contracts. Return only actionable findings that target
      valid diff ranges.
    \`,
    timeout: "10m",
    comment: (result, context) => {
      const inlineFindingSummary =
        result.inlineFindings.length === 0
          ? "No inline findings."
          : "See inline comments in the diff.";
      const localInlineFindingSummary = [
        "## Inline Findings",
        "",
        result.inlineFindings.length === 0
          ? "No inline findings."
          : result.inlineFindings.map((finding) => \`- \${finding.body}\`).join("\\n"),
      ].join("\\n");

      return {
        main: [
          "## Summary",
          "",
          result.summary.body,
          "",
          "## Review Result",
          "",
          "| Signal | Result |",
          "| --- | ---: |",
          \`| Inline findings | \${result.inlineFindings.length} |\`,
          "",
          context.platform.id === "local" ? localInlineFindingSummary : inlineFindingSummary,
        ].join("\\n"),
        inlineFindings: result.inlineFindings,
      };
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
