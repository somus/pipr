import type { OfficialInitRecipe } from "./types.js";

export const prHygieneRecipe = {
  id: "pr-hygiene",
  requiresChecksPermission: true,
  title: "PR Hygiene",
  description: "Change request hygiene checks for tests, docs, lockfiles, and size.",
  sourceTools: ["Danger JS"],
  configTs: `import { defaultReviewActions, definePipr, md, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "medium" });

  pipr.config({ publication: { maxInlineComments: 5 } });

  const policy = z.enum(["tests", "docs", "lockfiles", "generated-files", "change-size"]);
  const policyCheck = <const Policy extends z.infer<typeof policy>>(name: Policy) =>
    z.strictObject({
      policy: z.literal(name),
      status: z.enum(["pass", "attention", "not-applicable"]),
      evidence: z.string(),
    });
  const hygieneFinding = pipr.finding({ title: z.string().min(1).max(160), policy });

  const hygiene = pipr.agent({
    name: "pr-hygiene",
    model,
    instructions: \`
      Review change request hygiene, not code correctness. Evaluate tests, docs,
      lockfiles, generated files, and change size. Return exactly one policy
      check for each policy, using not-applicable when it does not apply. Ground
      evidence in changed files or counts. Use policy attention for file-level
      gaps; return inline findings only for concrete gaps in exact changed lines.
    \`,
    output: z.strictObject({
      summary: z.string(),
      checks: z.tuple([
        policyCheck("tests"),
        policyCheck("docs"),
        policyCheck("lockfiles"),
        policyCheck("generated-files"),
        policyCheck("change-size"),
      ]),
      findings: z.array(hygieneFinding),
    }),
    tools: pipr.tools.readOnly,
    timeout: "6m",
    prompt: () => "Check this change request for repository hygiene and merge readiness.",
  });

  pipr.task({
    name: "pr-hygiene",
    on: {
      changeRequest: defaultReviewActions,
      command: { pattern: "@pipr hygiene", permission: "write" },
    },
    check: { enabled: true, name: "pr hygiene", required: false },
    async run(ctx) {
      const changedFiles = await ctx.change.changedFiles();
      ctx.log.info(\`Checking PR hygiene for \${changedFiles.length} changed file(s).\`);
      const diff = await ctx.change.diff({ compressed: true, maxPreviewLines: 80 });
      const result = await ctx.pi.run(hygiene, { diff, changedFiles });
      const { findings } = ctx.review.select(result.findings, { finding: hygieneFinding });
      const attentionCount = result.checks.filter((check) => check.status === "attention").length;
      if (attentionCount > 0) {
        ctx.check.neutral(
          \`\${attentionCount} hygiene \${attentionCount === 1 ? "check needs" : "checks need"} attention.\`,
        );
      } else {
        ctx.check.pass("PR hygiene review completed.");
      }
      await ctx.comment({
        main: md.blocks(
          attentionCount === 0
            ? md.callout({
                icon: "✅",
                title: "PR hygiene passed",
                body: "All applicable policy checks passed.",
              })
            : md.callout({
                icon: "⚠️",
                title: "PR hygiene needs attention",
                body: \`\${attentionCount} policy \${attentionCount === 1 ? "check requires" : "checks require"} review.\`,
              }),
          md\`## 🧭 Summary\`,
          md\`\${result.summary}\`,
          md\`## Policy Checks\`,
          md.table(
            result.checks.map((check) => ({
              policy: md.label(check.policy),
              status: md.label(check.status),
              evidence: check.evidence,
            })),
            { policy: "Policy", status: "Status", evidence: "Evidence" },
          ),
        ),
        inlineFindings: findings.map((finding) => ({
          ...finding,
          body: String(md\`**\${md.label(finding.policy)}:** \${finding.title}. \${finding.body}\`),
        })),
      });
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
