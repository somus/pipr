import type { OfficialInitRecipe } from "./types.js";

export const qualityGateRecipe = {
  id: "quality-gate",
  requiresChecksPermission: true,
  title: "Quality Gate",
  description: "Required review check that fails on blocking correctness and test risks.",
  sourceTools: ["SonarQube", "Snyk"],
  configTs: `import { defaultReviewActions, definePipr, md, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  pipr.config({
    publication: {
      maxInlineComments: 6,
      autoResolve: {
        enabled: true,
        model,
        instructions:
          "Resolve only when current-head evidence proves the original concrete risk no longer applies; otherwise return unknown.",
        synchronize: true,
        userReplies: { enabled: true, allowedActors: "write" },
      },
    },
    checks: {
      aggregate: { enabled: true, name: "pipr quality gate" },
    },
    limits: {
      timeoutSeconds: 420,
      diffManifest: {
        fullMaxEstimatedTokens: 32000,
        condensedMaxEstimatedTokens: 64000,
      },
    },
  });

  const blocker = pipr.finding({
    title: z.string().min(1).max(160),
    category: z.enum(["correctness", "security", "reliability", "test-coverage"]),
    impact: z.string().min(1).max(1000),
  });

  const reviewer = pipr.agent({
    name: "quality-gate",
    model,
    instructions: \`
      Act as a merge quality gate. Report only blocking correctness, security,
      reliability, or test coverage issues that must prevent merge. A blocker
      must have a concrete changed-code range and an impact that maintainers can
      verify through the changed contract, relevant callers, or tests. If no
      blocking issue exists, return an empty blockers array.
    \`,
    output: z.strictObject({ summary: z.string(), blockers: z.array(blocker) }),
    tools: pipr.tools.readOnly,
    timeout: "7m",
    prompt: () => "Run the required quality gate for this change request.",
  });

  pipr.task({
    name: "quality-gate",
    on: {
      changeRequest: defaultReviewActions,
      command: { pattern: "@pipr quality", permission: "write" },
    },
    check: { enabled: true, name: "quality gate", required: true },
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true });
      const result = await ctx.pi.run(reviewer, { diff });
      const { findings: blockers, dropped } = ctx.review.select(result.blockers, {
        finding: blocker,
        limit: result.blockers.length,
      });
      const gate = ctx.check.gate(blockers, {
        failOn: () => true,
        summary: (blocking) =>
          blocking.length === 0
            ? "No blocking quality issues found."
            : \`\${blocking.length} blocking quality \${blocking.length === 1 ? "issue" : "issues"} found.\`,
      });

      await ctx.comment({
        main: md.blocks(
          gate.passed
            ? md.callout({ icon: "✅", title: "Quality gate passed", body: "No blocking findings." })
            : md.callout({
                icon: "❌",
                title: "Quality gate failed",
                body: \`\${blockers.length} blocking \${blockers.length === 1 ? "finding requires" : "findings require"} attention.\`,
              }),
          md\`## 🧭 Summary\`,
          md\`\${result.summary}\`,
          dropped.length > 0
            ? md\`<sub>\${dropped.length} model-reported \${dropped.length === 1 ? "blocker was" : "blockers were"} ignored because \${dropped.length === 1 ? "it does" : "they do"} not match a commentable diff range or duplicates another blocker.</sub>\`
            : "",
          blockers.length > 0 ? md\`## ⚠️ Blocking Findings\` : "",
          md.table(
            blockers.map((item) => ({
              category: md.label(item.category),
              title: item.title,
              impact: item.impact,
            })),
            { category: "Category", title: "Title", impact: "Impact" },
          ),
          blockers.length > 0
            ? md.details(
                "Category breakdown",
                md.table(categoryCounts(blockers), { category: "Category", count: "Count" }),
              )
            : "",
        ),
        inlineFindings: blockers.map((item) => ({
          ...item,
          body: String(md\`**\${md.label(item.category)} blocker:** \${item.title}. \${item.body}\`),
        })),
      });
    },
  });
});

function categoryCounts(blockers: readonly { category: string }[]) {
  const counts = new Map<string, number>();
  for (const blocker of blockers) {
    counts.set(blocker.category, (counts.get(blocker.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([category, count]) => ({ category: md.label(category), count }));
}
`,
} as const satisfies OfficialInitRecipe;
