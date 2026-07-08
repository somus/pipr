import type { OfficialInitRecipe } from "./types.js";

export const defaultReviewRecipe = {
  id: "default-review",
  title: "Default Review",
  description: "General pull request review with bounded inline comments.",
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
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    \`,
    timeout: "10m",
    comment: (result, context) => ({
      main: [
        "## Summary",
        "",
        result.summary.body,
        "",
        "## Review Result",
        "",
        reviewResultTable(result.inlineFindings.length),
        "",
        context.platform.id === "local"
          ? inlineFindingsSection(result.inlineFindings)
          : inlineFindingsNote(result.inlineFindings.length),
      ].join("\\n"),
      inlineFindings: result.inlineFindings,
    }),
  });
});

function reviewResultTable(inlineFindingCount: number): string {
  return [
    "| Signal | Result |",
    "| --- | ---: |",
    \`| Inline findings | \${inlineFindingCount} |\`,
  ].join("\\n");
}

function inlineFindingsNote(inlineFindingCount: number): string {
  return inlineFindingCount === 0 ? "No inline findings." : "See inline comments in the diff.";
}

function inlineFindingsSection(findings: Array<{ body: string }>): string {
  return [
    "## Inline Findings",
    "",
    findings.length === 0 ? "No inline findings." : findings.map((finding) => \`- \${finding.body}\`).join("\\n"),
  ].join("\\n");
}
`,
} as const satisfies OfficialInitRecipe;
