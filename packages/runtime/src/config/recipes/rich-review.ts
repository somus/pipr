import type { OfficialInitRecipe } from "./types.js";

export const structuredReviewRecipe = {
  id: "rich-review",
  title: "Structured Review",
  description: "General change request review with severity and category metadata.",
  sourceTools: ["CodeRabbit", "Qodo Merge", "Greptile"],
  configTs: `import { definePipr, md, z } from "@usepipr/sdk";
import type { ReviewSummaryInput } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  pipr.config({
    publication: {
      maxInlineComments: 8,
      autoResolve: {
        enabled: true,
        synchronize: true,
        userReplies: {
          enabled: true,
          respondWhenStillValid: true,
          allowedActors: "write",
        },
      },
    },
  });

  const finding = pipr.finding({
    title: z.string().min(1).max(160),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.enum([
      "correctness",
      "security",
      "reliability",
      "performance",
      "test-coverage",
      "maintainability",
      "documentation",
    ]),
    rationale: z.string().min(1).max(1200),
  });
  type Finding = z.infer<typeof finding>;

  const summary = pipr.agent<ReviewSummaryInput<Finding>, z.infer<typeof summarySchema>>({
    name: "summary-reviewer",
    model,
    instructions: \`
      Make the summary maintainer-facing and scannable: one concrete headline,
      one to four behavior-focused change bullets, a risk level with rationale,
      and reviewer focus only for useful human follow-up. Use the selected
      findings as evidence, but do not invent additional defects or copy
      secret-looking literals into any summary field.
    \`,
    output: summarySchema,
    tools: pipr.tools.readOnly,
    timeout: "10m",
    prompt: ({ diff, findings }) =>
      pipr.prompt\`
        Summarize this change using the selected findings.

        \${pipr.section("Changed files", pipr.json(diff, { maxCharacters: 60_000 }))}

        \${pipr.section("Selected findings", pipr.json(findings, { maxCharacters: 60_000 }))}
      \`,
  });

  pipr.review({
    id: "review",
    model,
    finding,
    instructions: \`
      Review the change request diff for correctness, security, reliability,
      performance, test coverage, maintainability, and documentation risks.
      Assign severity by merge impact: critical for exploitable, data-loss, or
      widespread outage risks; high for other merge-blocking defects; medium for
      concrete non-blocking defects; and low for small but actionable issues. Each
      rationale must connect repository evidence to the defect and its concrete
      impact. Keep each finding title to one line. Put supporting evidence and
      reasoning in rationale instead of appending it to the body. Return no more
      than 20 findings for each diff shard.
      Never copy secret-looking literals into title, body, rationale, or
      suggestedFix. Describe only the secret kind and location.
    \`,
    summary: { agent: summary },
    timeout: "10m",
    render: ({ findings, summary }) => ({
      main: md.blocks(
        md\`## 🧭 Summary\`,
        summary ? md\`**\${md.line(summary.headline)}**\` : "",
        summary
          ? md\`**Review risk:** \${md.label(summary.riskLevel)}. \${md.line(summary.riskSummary)}\`
          : "",
        md\`## 🗺️ What Changed\`,
        md.list(summary?.changeSummary ?? []),
        summary?.reviewerFocus.length ? md\`## 🎯 Reviewer Focus\` : "",
        md.list(summary?.reviewerFocus ?? []),
      ),
      inlineFindings: findings.map((finding) => ({
        ...finding,
        body: String(
          md.blocks(
            md\`**\${md.label(finding.severity)} \${finding.category.replaceAll("-", " ")}:** \${md.line(finding.title)}\`,
            md\`\${finding.body}\`,
            md.details("Rationale", md\`\${finding.rationale}\`),
          ),
        ),
      })),
    }),
  });
});

const summarySchema = z.strictObject({
  headline: z.string().min(1).max(160),
  changeSummary: z.array(z.string().min(1).max(500)).min(1).max(4),
  riskLevel: z.enum(["low", "medium", "high"]),
  riskSummary: z.string().min(1).max(500),
  reviewerFocus: z.array(z.string().min(1).max(500)).max(4),
});
`,
} as const satisfies OfficialInitRecipe;
