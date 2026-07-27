import type { OfficialInitRecipe } from "./types.js";

export const defaultReviewRecipe = {
  id: "default-review",
  title: "Default Review",
  description: "General change request review with bounded inline comments.",
  sourceTools: ["pipr"],
  configTs: `import { definePipr } from "@usepipr/sdk";

function nestedSummary(body: string): string {
  return body
    .replace(/^\\s*#{1,6}[ \\t]+Summary[ \\t]*\\r?\\n+/i, "")
    .replace(/^#{1,2}[ \\t]+/gm, "### ");
}

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "high",
  });

  pipr.config({ publication: { maxInlineComments: 5 } });

  pipr.review({
    id: "review",
    model,
    instructions: {
      findings: \`
        Review changed behavior for correctness, security, maintainability, and
        meaningful regression gaps. Focus on concrete impact and compatibility
        with repository contracts. Return only actionable findings that target
        valid diff ranges.
      \`,
      summary: \`
        Summarize the changed behavior, overall risk, and useful reviewer focus.
        Use merged findings as evidence without introducing new defects.
      \`,
    },
    timeout: "10m",
    comment: (result, context) => {
      const sections = ["## 🧭 Summary", "", nestedSummary(result.summary.body)];
      if (result.inlineFindings.length > 0) {
        sections.push(
          "",
          "## ⚠️ Findings",
          "",
          context.run.trigger === "local"
            ? result.inlineFindings.map((finding) => \`- \${finding.body}\`).join("\\n")
            : "See inline comments in the diff.",
        );
      }

      return {
        main: sections.join("\\n"),
        inlineFindings: result.inlineFindings,
      };
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
