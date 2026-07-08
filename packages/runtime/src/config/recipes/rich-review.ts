import type { OfficialInitRecipe } from "./types.js";

export const structuredReviewRecipe = {
  id: "rich-review",
  title: "Structured Review",
  description: "General pull request review with severity and category metadata.",
  sourceTools: ["CodeRabbit", "Qodo Merge", "Greptile"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { ReviewFinding } from "@usepipr/sdk";

type CategorizedFinding = {
  title: string;
  severity: "critical" | "high" | "medium" | "low" | "nit";
  category:
    | "correctness"
    | "security"
    | "reliability"
    | "performance"
    | "test-coverage"
    | "maintainability"
    | "documentation";
  rationale: string;
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
};

const categorizedFindingSchema = z.strictObject({
  title: z.string(),
  severity: z.enum(["critical", "high", "medium", "low", "nit"]),
  category: z.enum([
    "correctness",
    "security",
    "reliability",
    "performance",
    "test-coverage",
    "maintainability",
    "documentation",
  ]),
  rationale: z.string(),
  body: z.string(),
  path: z.string(),
  rangeId: z.string(),
  side: z.enum(["RIGHT", "LEFT"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  suggestedFix: z.string().optional(),
});

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 8 } });

  const reviewOutput = pipr.schema({
    id: "review/categorized-findings",
    schema: z.strictObject({
      summary: z.string(),
      findings: z.array(categorizedFindingSchema),
    }),
  });

  const reviewer = pipr.agent({
    name: "reviewer",
    model,
    instructions: \`
      Review the pull request diff for correctness, security, reliability,
      performance, test coverage, maintainability, and documentation risks.
      Return only actionable findings that target valid diff ranges. Assign
      severity by merge impact: critical and high for merge-blocking defects,
      medium for important follow-up, low for minor actionable improvements,
      and nit only for tiny but concrete issues. Include suggestedFix only when
      there is an exact replacement for the selected range.
    \`,
    output: reviewOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "10m",
    prompt: () => "Review this change with severity and category metadata.",
  });

  const task = pipr.task({
    name: "review",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(reviewer, { manifest });
      const inlineFindings: ReviewFinding[] = result.findings.map((finding) => {
        const severity = finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1);
        const category = finding.category.replaceAll("-", " ");
        return {
          body: \`**\${severity} \${category}:** \${finding.title}. \${finding.body}\`,
          path: finding.path,
          rangeId: finding.rangeId,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          ...(finding.suggestedFix ? { suggestedFix: finding.suggestedFix } : {}),
        };
      });
      await ctx.comment({
        main: [
          result.summary,
          "",
          "## Findings",
          "",
          findingsTable(result.findings),
          "",
          "<details>",
          "<summary>Finding rationales</summary>",
          "",
          findingRationales(result.findings),
          "",
          "</details>",
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr review", permission: "write", task });
});

function findingsTable(findings: CategorizedFinding[]): string {
  if (findings.length === 0) {
    return [
      "| Severity | Category | Title |",
      "| --- | --- | --- |",
      "| - | - | No findings. |",
    ].join("\\n");
  }
  return [
    "| Severity | Category | Title |",
    "| --- | --- | --- |",
    ...findings.map((finding) => {
      const severity = finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1);
      const category = finding.category.replaceAll("-", " ").replaceAll("|", "\\\\|");
      const title = finding.title.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
      return \`| \${severity} | \${category} | \${title} |\`;
    }),
  ].join("\\n");
}

function findingRationales(findings: CategorizedFinding[]): string {
  if (findings.length === 0) {
    return "No findings.";
  }
  return findings
    .map((finding, index) =>
      [
        \`### \${index + 1}. \${finding.title}\`,
        "",
        \`**Severity:** \${finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1)}\`,
        \`**Category:** \${finding.category.replaceAll("-", " ")}\`,
        "",
        finding.rationale,
      ].join("\\n"),
    )
    .join("\\n\\n");
}
`,
} as const satisfies OfficialInitRecipe;
