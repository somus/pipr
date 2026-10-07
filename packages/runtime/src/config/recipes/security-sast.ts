import type { OfficialInitRecipe } from "./types.js";

export const securitySastRecipe = {
  id: "security-sast",
  requiresChecksPermission: true,
  title: "Security SAST",
  description: "Security review with custom severity and category output.",
  sourceTools: ["Semgrep", "Snyk", "GitHub CodeQL/code scanning"],
  configTs: `import { defaultReviewActions, definePipr, md, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  const risk = pipr.finding({
    title: z.string().min(1).max(160),
    severity: z.enum(["critical", "high", "medium", "low"]),
    category: z.enum(["auth", "injection", "secret", "crypto", "data-exposure", "other"]),
    rationale: z.string().min(1).max(1200),
  });

  const security = pipr.agent({
    name: "security-sast",
    model,
    instructions: \`
      Review for exploitable security issues only. Focus on auth bypasses,
      injection, unsafe deserialization, secret exposure, cryptography misuse,
      authorization gaps, and data exposure. Require a changed trust boundary or
      source-to-sink path and anchor every risk to the exact changed range that
      creates or weakens it. Do not report hypothetical or style-only issues.
      Make summary maintainer-facing and scannable with a concrete headline,
      risk rationale, and only useful security follow-up. Set
      diagramMermaid only when a high or critical risk has a concrete source-to-sink
      path and a small Mermaid flowchart clarifies it. Do not include Markdown
      fences in diagramMermaid.
    \`,
    output: z.strictObject({
      summary: z.strictObject({
        headline: z.string().min(1).max(160),
        riskSummary: z.string().min(1).max(1000),
        reviewerFocus: z.array(z.string().min(1).max(500)).max(4),
      }),
      risks: z.array(risk),
      diagramMermaid: z.string().min(1).optional(),
    }),
    tools: pipr.tools.readOnly,
    prompt: () => pipr.prompt\`
      \${pipr.section("Security review policy", "Return only risks with a concrete attack path.")}
    \`,
  });

  pipr.task({
    name: "security-sast",
    on: {
      changeRequest: defaultReviewActions,
      command: { pattern: "@pipr security", permission: "write" },
    },
    check: { enabled: true, name: "security-sast", required: true },
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true });
      const result = await ctx.pi.run(security, { diff });
      const { findings: risks, dropped } = ctx.review.select(result.risks, {
        finding: risk,
        limit: result.risks.length,
      });
      const gate = ctx.check.gate(risks, {
        failOn: { severity: ["critical", "high"] },
        summary: (blocking) =>
          blocking.length === 0
            ? "No high or critical security risks found."
            : "High or critical security risk found.",
      });
      const blockingCount = gate.blocking.length;

      await ctx.comment({
        main: md.blocks(
          gate.passed
            ? md.callout({ icon: "✅", title: "Security gate passed", body: "No high or critical risks." })
            : md.callout({
                icon: "❌",
                title: "Security gate failed",
                body: \`\${blockingCount} high or critical \${blockingCount === 1 ? "risk requires" : "risks require"} attention.\`,
              }),
          md\`## 🧭 Summary\`,
          md\`**\${md.line(result.summary.headline)}**\`,
          md\`\${result.summary.riskSummary}\`,
          result.summary.reviewerFocus.length > 0 ? md\`## 🎯 Reviewer Focus\` : "",
          md.list(result.summary.reviewerFocus),
          risks.length > 0 ? md\`## ⚠️ Security Risks\` : "",
          md.table(
            risks.map((item) => ({
              severity: md.label(item.severity),
              category: item.category,
              title: item.title,
            })),
            { severity: "Severity", category: "Category", title: "Title" },
          ),
          dropped.length > 0
            ? \`Omitted \${dropped.length} \${dropped.length === 1 ? "risk" : "risks"} with an invalid or duplicate anchor.\`
            : "",
          md.details(
            "Risk rationales",
            md.blocks(
              ...risks.map(
                (item, index) => md\`
                  ### \${index + 1}. \${md.line(item.title)}

                  **Severity:** \${md.label(item.severity)}
                  **Category:** \${md.label(item.category)}

                  \${item.rationale}
                \`,
              ),
            ),
          ),
          !gate.passed && result.diagramMermaid?.trim()
            ? md.details("Attack path diagram", mermaidBlock(result.diagramMermaid))
            : "",
        ),
        inlineFindings: risks,
      });
    },
  });
});

function mermaidBlock(diagram: string) {
  const longestBacktickRun = Math.max(0, ...[...diagram.matchAll(/\`+/g)].map((match) => match[0].length));
  const fence = "\`".repeat(Math.max(3, longestBacktickRun + 1));
  return md.raw(\`\${fence}mermaid\\n\${diagram.trim()}\\n\${fence}\`);
}
`,
} as const satisfies OfficialInitRecipe;
