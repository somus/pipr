import type { OfficialInitRecipe } from "./types.js";

export const defaultReviewRecipe = {
  id: "default-review",
  title: "Default Review",
  description: "General change request review with bounded inline comments.",
  sourceTools: ["pipr"],
  configTs: `import { definePipr, md } from "@usepipr/sdk";

function nestedSummary(body: string): string {
  return body
    .replace(/^\\s*#{1,6}[ \\t]+Summary[ \\t]*\\r?\\n+/i, "")
    .replace(/^#{1,2}[ \\t]+/gm, "### ");
}

export default definePipr((pipr) => {
  pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  pipr.config({ publication: { maxInlineComments: 5 } });

  pipr.review({
    id: "review",
    instructions: \`
      Review changed behavior for correctness, security, maintainability, and
      meaningful regression gaps. Focus on concrete impact and compatibility
      with repository contracts. Return only actionable findings that target
      valid diff ranges.
    \`,
    summary: {
      instructions: \`
        Summarize the changed behavior, overall risk, and useful reviewer focus.
        Use the selected findings as evidence without introducing new defects.
      \`,
    },
    timeout: "10m",
    render: ({ findings, summary }, context) => ({
      main: md.blocks(
        md\`## 🧭 Summary\`,
        md.raw(nestedSummary(summary?.body ?? "")),
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
