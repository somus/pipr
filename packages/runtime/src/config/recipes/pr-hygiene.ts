import type { OfficialInitRecipe } from "./types.js";

export const prHygieneRecipe = {
  id: "pr-hygiene",
  title: "PR Hygiene",
  description: "Danger-style PR hygiene checks for tests, docs, lockfiles, and size.",
  sourceTools: ["Danger JS"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { ReviewFinding } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "medium" },
  });

  pipr.config({ publication: { maxInlineComments: 5 } });

  const hygienePolicySchema = z.enum([
    "tests",
    "docs",
    "lockfiles",
    "generated-files",
    "change-size",
  ]);

  const policyCheckSchema = z.strictObject({
    policy: hygienePolicySchema,
    status: z.enum(["pass", "attention", "not-applicable"]),
    evidence: z.string(),
  });

  const hygieneFindingSchema = z.strictObject({
    title: z.string(),
    policy: hygienePolicySchema,
    body: z.string(),
    path: z.string(),
    rangeId: z.string(),
    side: z.enum(["RIGHT", "LEFT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    suggestedFix: z.string().optional(),
  });

  type PolicyCheck = z.infer<typeof policyCheckSchema>;
  type HygieneFinding = z.infer<typeof hygieneFindingSchema>;

  const hygieneOutput = pipr.schema({
    id: "review/pr-hygiene",
    schema: z.strictObject({
      summary: z.string(),
      checks: z.array(policyCheckSchema),
      findings: z.array(hygieneFindingSchema),
    }),
  });

  const hygiene = pipr.agent({
    name: "pr-hygiene",
    model,
    instructions: \`
      Review pull request hygiene, not code correctness. Evaluate tests, docs,
      lockfiles, generated files, and change size. Return one policy check per
      relevant policy. Return inline findings only for concrete hygiene gaps
      that maintainers can act on in the changed lines.
    \`,
    output: hygieneOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "6m",
    prompt: () => "Check this pull request for repository hygiene and merge readiness.",
  });

  const task = pipr.task({
    name: "pr-hygiene",
    check: { enabled: true, name: "pr hygiene", required: false },
    async run(ctx) {
      const changedFiles = await ctx.change.changedFiles();
      ctx.log.info(\`Checking PR hygiene for \${changedFiles.length} changed file(s).\`);
      const manifest = await ctx.change.diffManifest({ compressed: true, maxPreviewLines: 80 });
      const result = await ctx.pi.run(hygiene, { manifest, changedFiles });
      const inlineFindings: ReviewFinding[] = result.findings.map((finding) => {
        const policy = finding.policy
          .replaceAll("-", " ")
          .replace(/^./, (char) => char.toUpperCase());
        return {
          body: \`**\${policy}:** \${finding.title}. \${finding.body}\`,
          path: finding.path,
          rangeId: finding.rangeId,
          side: finding.side,
          startLine: finding.startLine,
          endLine: finding.endLine,
          ...(finding.suggestedFix ? { suggestedFix: finding.suggestedFix } : {}),
        };
      });
      ctx.check.pass("PR hygiene review completed.");
      await ctx.comment({
        main: [
          "## PR Hygiene",
          "",
          result.summary,
          "",
          "## Policy Checks",
          "",
          policyTable(result.checks),
          "",
          "## Selected Findings",
          "",
          findingsTable(result.findings),
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr hygiene", permission: "write", task });
});

function policyTable(checks: PolicyCheck[]): string {
  if (checks.length === 0) {
    return [
      "| Policy | Status | Evidence |",
      "| --- | --- | --- |",
      "| - | Not applicable | No policy checks were relevant. |",
    ].join("\\n");
  }
  return [
    "| Policy | Status | Evidence |",
    "| --- | --- | --- |",
    ...checks.map((check) => {
      const policy = check.policy
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      const status = check.status
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      const evidence = check.evidence.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
      return \`| \${policy} | \${status} | \${evidence} |\`;
    }),
  ].join("\\n");
}

function findingsTable(findings: HygieneFinding[]): string {
  if (findings.length === 0) {
    return [
      "| Policy | Finding |",
      "| --- | --- |",
      "| - | No selected hygiene findings. |",
    ].join("\\n");
  }
  return [
    "| Policy | Finding |",
    "| --- | --- |",
    ...findings.map((finding) => {
      const policy = finding.policy
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      const title = finding.title.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
      return \`| \${policy} | \${title} |\`;
    }),
  ].join("\\n");
}
`,
} as const satisfies OfficialInitRecipe;
