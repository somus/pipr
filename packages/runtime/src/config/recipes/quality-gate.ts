import type { OfficialInitRecipe } from "./types.js";

export const qualityGateRecipe = {
  id: "quality-gate",
  title: "Quality Gate",
  description: "Required review check that fails on blocking correctness and test risks.",
  sourceTools: ["SonarQube", "Snyk"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { CommentableRange, DiffManifest, ReviewFinding } from "@usepipr/sdk";

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
      const commentableBlockers = result.blockers.filter((blocker) =>
        commentableRangeForFinding(blocker, manifest) !== undefined,
      );
      const droppedBlockerCount = result.blockers.length - commentableBlockers.length;
      const inlineFindings: ReviewFinding[] = commentableBlockers.map((blocker) => {
        const category = blocker.category
          .replaceAll("-", " ")
          .replace(/^./, (char) => char.toUpperCase());
        return {
          body: \`**\${category} blocker:** \${blocker.title}. \${blocker.body}\`,
          path: blocker.path,
          rangeId: blocker.rangeId,
          side: blocker.side,
          startLine: blocker.startLine,
          endLine: blocker.endLine,
          ...(blocker.suggestedFix ? { suggestedFix: blocker.suggestedFix } : {}),
        };
      });

      if (commentableBlockers.length > 0) {
        const issueNoun = commentableBlockers.length === 1 ? "issue" : "issues";
        ctx.check.fail(\`\${commentableBlockers.length} blocking quality \${issueNoun} found.\`);
      } else {
        ctx.check.pass("No blocking quality issues found.");
      }

      await ctx.comment({
        main: [
          statusTable(commentableBlockers),
          "",
          droppedBlockersNote(droppedBlockerCount),
          "",
          result.summary,
          "",
          "## Blocking Findings",
          "",
          blockersTable(commentableBlockers),
          "",
          "## Category Breakdown",
          "",
          categoryBreakdownTable(commentableBlockers),
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr quality", permission: "write", task });
});

type FindingAnchor = Pick<ReviewFinding, "path" | "rangeId" | "side" | "startLine" | "endLine">;

function commentableRangeForFinding(
  finding: FindingAnchor,
  manifest: DiffManifest,
): CommentableRange | undefined {
  for (const file of manifest.files) {
    const range = file.commentableRanges.find((candidate) => candidate.id === finding.rangeId);
    if (!range) {
      continue;
    }
    return finding.rangeId === range.id &&
      finding.path === range.path &&
      finding.side === range.side &&
      finding.startLine <= finding.endLine &&
      finding.startLine >= range.startLine &&
      finding.endLine <= range.endLine
      ? range
      : undefined;
  }
  return undefined;
}

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
    ...blockers.map((blocker) => {
      const category = blocker.category
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      const title = blocker.title.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
      const impact = blocker.impact.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
      return \`| \${category} | \${title} | \${impact} |\`;
    }),
  ].join("\\n");
}

function droppedBlockersNote(count: number): string {
  if (count === 0) {
    return "";
  }
  const blockerNoun = count === 1 ? "blocker" : "blockers";
  const verb = count === 1 ? "was" : "were";
  const pronoun = count === 1 ? "it does" : "they do";
  return [
    "<sub>",
    count,
    " model-reported ",
    blockerNoun,
    " ",
    verb,
    " ignored because ",
    pronoun,
    " not match a commentable diff range.",
    "</sub>",
  ].join("");
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
    ...counts.map(([category, count]) => {
      const categoryLabel = category
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      return \`| \${categoryLabel} | \${count} |\`;
    }),
  ].join("\\n");
}

function categorySummary(blockers: QualityBlocker[]): string {
  const counts = categoryCounts(blockers);
  if (counts.length === 0) {
    return "None";
  }
  return counts
    .map(([category, count]) => {
      const categoryLabel = category
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      return \`\${categoryLabel} (\${count})\`;
    })
    .join(", ");
}

function categoryCounts(blockers: QualityBlocker[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const blocker of blockers) {
    counts.set(blocker.category, (counts.get(blocker.category) ?? 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
}

`,
} as const satisfies OfficialInitRecipe;
