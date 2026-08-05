import type { OfficialInitRecipe } from "./types.js";

export const qualityGateRecipe = {
  id: "quality-gate",
  requiresChecksPermission: true,
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
    thinking: "high",
  });

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
      verify through the changed contract, relevant callers, or tests. If no
      blocking issue exists, return an empty blockers array.
    \`,
    output: qualityGateOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "7m",
    prompt: () => "Run the required quality gate for this change request.",
  });

  const task = pipr.task({
    name: "quality-gate",
    check: { enabled: true, name: "quality gate", required: true },
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(reviewer, { manifest });
      const { validFindings: commentableBlockers, droppedFindings } =
        ctx.review.validateFindings(result.blockers);
      const droppedBlockerCount = droppedFindings.length;
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

      const sections = [
        qualityGateCallout(commentableBlockers),
        "",
        "## 🧭 Summary",
        "",
        result.summary,
      ];
      if (droppedBlockerCount > 0) {
        sections.push("", droppedBlockersNote(droppedBlockerCount));
      }
      if (commentableBlockers.length > 0) {
        sections.push(
          "",
          "## ⚠️ Blocking Findings",
          "",
          blockersTable(commentableBlockers),
          "",
          categoryBreakdownBlock(commentableBlockers),
        );
      }
      await ctx.comment({
        main: sections.join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr quality", permission: "write", task });
});

function qualityGateCallout(blockers: QualityBlocker[]): string {
  if (blockers.length === 0) {
    return "> ✅ **Quality gate passed:** No blocking findings.";
  }
  const noun = blockers.length === 1 ? "finding requires" : "findings require";
  return \`> ❌ **Quality gate failed:** \${blockers.length} blocking \${noun} attention.\`;
}

function blockersTable(blockers: QualityBlocker[]): string {
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
    " not match a commentable diff range or duplicates another blocker.",
    "</sub>",
  ].join("");
}

function categoryBreakdownBlock(blockers: QualityBlocker[]): string {
  const counts = categoryCounts(blockers);
  return [
    "<details>",
    "<summary>Category breakdown</summary>",
    "",
    "| Category | Count |",
    "| --- | ---: |",
    ...counts.map(([category, count]) => {
      const categoryLabel = category
        .replaceAll("-", " ")
        .replace(/^./, (char) => char.toUpperCase());
      return \`| \${categoryLabel} | \${count} |\`;
    }),
    "",
    "</details>",
  ].join("\\n");
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
