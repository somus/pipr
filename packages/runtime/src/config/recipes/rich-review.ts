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

type ReviewSummary = {
  headline: string;
  changeSummary: string[];
  riskLevel: "low" | "medium" | "high";
  riskSummary: string;
  reviewerFocus: string[];
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

const reviewSummarySchema = z.strictObject({
  headline: z.string(),
  changeSummary: z.array(z.string()).min(1).max(4),
  riskLevel: z.enum(["low", "medium", "high"]),
  riskSummary: z.string(),
  reviewerFocus: z.array(z.string()).max(4),
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
      summary: reviewSummarySchema,
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

      Make summary maintainer-facing and scannable: one concrete headline, one
      to four behavior-focused change bullets, a risk level with rationale, and
      reviewer focus only for useful human follow-up. Put actionable defects in
      findings, not only in summary.
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
          "## Summary",
          "",
          \`**\${result.summary.headline}**\`,
          "",
          summaryTable(result.summary, result.findings.length),
          "",
          "## What Changed",
          "",
          bulletList(result.summary.changeSummary, "No changed behavior summarized."),
          "",
          "## Reviewer Focus",
          "",
          bulletList(result.summary.reviewerFocus, "No special reviewer focus."),
          "",
          "## Findings",
          "",
          findingsTable(result.findings),
          "",
          findingRationalesBlock(result.findings),
        ].filter(Boolean).join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr review", permission: "write", task });
});

function summaryTable(summary: ReviewSummary, findingCount: number): string {
  return [
    "| Outcome | Risk | Risk summary |",
    "| --- | --- | --- |",
    \`| \${findingOutcome(findingCount)} | \${labelValue(summary.riskLevel)} | \${tableCell(
      summary.riskSummary,
    )} |\`,
  ].join("\\n");
}

function findingOutcome(findingCount: number): string {
  if (findingCount === 0) {
    return "No findings";
  }
  return findingCount === 1 ? "1 finding" : \`\${findingCount} findings\`;
}

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

function findingRationalesBlock(findings: CategorizedFinding[]): string {
  if (findings.length === 0) {
    return "";
  }
  return [
    "<details>",
    "<summary>Finding rationales</summary>",
    "",
    findings
      .map((finding, index) =>
        [
          \`### \${index + 1}. \${finding.title}\`,
          "",
          \`**Severity:** \${labelValue(finding.severity)}\`,
          \`**Category:** \${labelValue(finding.category)}\`,
          "",
          finding.rationale,
        ].join("\\n"),
      )
      .join("\\n\\n"),
    "",
    "</details>",
  ].join("\\n");
}

function bulletList(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }
  return items.map((item) => \`- \${lineText(item)}\`).join("\\n");
}

function labelValue(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (char) => char.toUpperCase());
}

function lineText(value: string): string {
  return value.replaceAll("\\n", " ").trim();
}

function tableCell(value: string): string {
  return lineText(value).replaceAll("|", "\\\\|");
}
`,
} as const satisfies OfficialInitRecipe;
