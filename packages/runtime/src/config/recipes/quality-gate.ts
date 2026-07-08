import type { OfficialInitRecipe } from "./types.js";

export const qualityGateRecipe = {
  id: "quality-gate",
  title: "Quality Gate",
  description: "Required review check that fails on blocking correctness and test risks.",
  sourceTools: ["SonarQube", "Snyk"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { ReviewFinding } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({
    publication: {
      maxInlineComments: 6,
      autoResolve: {
        enabled: true,
        model,
        instructions: "Resolve only when the changed code addresses the finding directly.",
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

  const blockerSchema = z.strictObject({
    title: z.string(),
    category: z.enum(["correctness", "security", "reliability", "test-coverage"]),
    impact: z.string(),
    body: z.string(),
    path: z.string(),
    rangeId: z.string(),
    side: z.enum(["RIGHT", "LEFT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    suggestedFix: z.string().optional(),
  });

  type QualityBlocker = z.infer<typeof blockerSchema>;

  const qualityGateOutput = pipr.schema({
    id: "review/quality-gate",
    schema: z.strictObject({
      summary: z.string(),
      blockers: z.array(blockerSchema),
    }),
  });

  const reviewer = pipr.agent({
    name: "quality-gate",
    model,
    instructions: \`
      Act as a merge quality gate. Report only blocking correctness, security,
      reliability, or test coverage issues that must prevent merge. A blocker
      must have a concrete changed-code range and an impact that maintainers can
      verify. If no blocking issue exists, return an empty blockers array.
    \`,
    output: qualityGateOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "7m",
    prompt: () => "Run the required quality gate for this pull request.",
  });

  const task = pipr.task({
    name: "quality-gate",
    check: { enabled: true, name: "quality gate", required: true },
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(reviewer, { manifest });
      const inlineFindings: ReviewFinding[] = result.blockers.map((blocker) => ({
        body: \`**\${formatCategory(blocker.category)} blocker:** \${blocker.title}. \${blocker.body}\`,
        path: blocker.path,
        rangeId: blocker.rangeId,
        side: blocker.side,
        startLine: blocker.startLine,
        endLine: blocker.endLine,
        ...(blocker.suggestedFix ? { suggestedFix: blocker.suggestedFix } : {}),
      }));

      if (result.blockers.length > 0) {
        ctx.check.fail(\`\${result.blockers.length} blocking quality \${pluralize(
          result.blockers.length,
          "issue",
        )} found.\`);
      } else {
        ctx.check.pass("No blocking quality issues found.");
      }

      await ctx.comment({
        main: [
          "## Quality Gate",
          "",
          statusTable(result.blockers),
          "",
          result.summary,
          "",
          "## Blocking Findings",
          "",
          blockersTable(result.blockers),
          "",
          "## Category Breakdown",
          "",
          categoryBreakdownTable(result.blockers),
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr quality", permission: "write", task });
});

function statusTable(blockers: QualityBlocker[]): string {
  return [
    "| Status | Blocking findings | Categories |",
    "| --- | ---: | --- |",
    \`| \${blockers.length === 0 ? "Pass" : "Fail"} | \${blockers.length} | \${categorySummary(
      blockers,
    )} |\`,
  ].join("\\n");
}

function blockersTable(blockers: QualityBlocker[]): string {
  if (blockers.length === 0) {
    return [
      "| Category | Title | Impact |",
      "| --- | --- | --- |",
      "| - | No blocking findings. | - |",
    ].join("\\n");
  }
  return [
    "| Category | Title | Impact |",
    "| --- | --- | --- |",
    ...blockers.map(
      (blocker) =>
        \`| \${formatCategory(blocker.category)} | \${escapeTableCell(
          blocker.title,
        )} | \${escapeTableCell(blocker.impact)} |\`,
    ),
  ].join("\\n");
}

function categoryBreakdownTable(blockers: QualityBlocker[]): string {
  const counts = categoryCounts(blockers);
  if (counts.length === 0) {
    return [
      "| Category | Count |",
      "| --- | ---: |",
      "| - | 0 |",
    ].join("\\n");
  }
  return [
    "| Category | Count |",
    "| --- | ---: |",
    ...counts.map(([category, count]) => \`| \${formatCategory(category)} | \${count} |\`),
  ].join("\\n");
}

function categorySummary(blockers: QualityBlocker[]): string {
  const counts = categoryCounts(blockers);
  if (counts.length === 0) {
    return "None";
  }
  return counts.map(([category, count]) => \`\${formatCategory(category)} (\${count})\`).join(", ");
}

function categoryCounts(blockers: QualityBlocker[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const blocker of blockers) {
    counts.set(blocker.category, (counts.get(blocker.category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

function pluralize(count: number, singular: string): string {
  return count === 1 ? singular : \`\${singular}s\`;
}

function formatCategory(category: string): string {
  return category.replaceAll("-", " ").replace(/^./, (char) => char.toUpperCase());
}

function escapeTableCell(value: string): string {
  return value.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
}
`,
} as const satisfies OfficialInitRecipe;
