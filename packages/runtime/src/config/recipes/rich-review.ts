import type { OfficialInitRecipe } from "./types.js";

export const structuredReviewRecipe = {
  id: "rich-review",
  title: "Structured Review",
  description: "General change request review with severity and category metadata.",
  sourceTools: ["CodeRabbit", "Qodo Merge", "Greptile"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type {
  DefaultReviewSummaryManifest,
  DiffManifest,
  ReviewFinding,
} from "@usepipr/sdk";

type ReviewSummary = {
  headline: string;
  changeSummary: string[];
  riskLevel: "low" | "medium" | "high";
  riskSummary: string;
  reviewerFocus: string[];
};

const categorizedFindingSchema = z.strictObject({
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
  body: z.string().min(1).max(700),
  path: z.string().min(1),
  rangeId: z.string().min(1),
  side: z.enum(["RIGHT", "LEFT"]),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  suggestedFix: z.string().min(1).optional(),
});
type CategorizedFinding = ReviewFinding & {
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  category:
    | "correctness"
    | "security"
    | "reliability"
    | "performance"
    | "test-coverage"
    | "maintainability"
    | "documentation";
  rationale: string;
};

const reviewSummarySchema = z.strictObject({
  headline: z.string().min(1).max(160),
  changeSummary: z.array(z.string().min(1).max(500)).min(1).max(4),
  riskLevel: z.enum(["low", "medium", "high"]),
  riskSummary: z.string().min(1).max(500),
  reviewerFocus: z.array(z.string().min(1).max(500)).max(4),
});

const severityRank = { critical: 0, high: 1, medium: 2, low: 3 } as const;

function hasCommentableAnchor(
  finding: ReviewFinding,
  manifest: DiffManifest,
): boolean {
  const range = manifest.files
    .find((file) => file.path === finding.path)
    ?.commentableRanges.find(
      (candidate) =>
        candidate.id === finding.rangeId &&
        candidate.path === finding.path &&
        candidate.side === finding.side,
    );
  return Boolean(
    range &&
      finding.startLine <= finding.endLine &&
      finding.startLine >= range.startLine &&
      finding.endLine <= range.endLine,
  );
}

function deduplicateFindings(findings: CategorizedFinding[]): CategorizedFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = JSON.stringify([
      finding.path,
      finding.rangeId,
      finding.side,
      finding.startLine,
      finding.endLine,
      finding.body,
    ]);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function summaryManifest(manifest: DiffManifest): DefaultReviewSummaryManifest {
  const files: DefaultReviewSummaryManifest["files"][number][] = [];
  let serializedCharacters = 0;

  for (const file of manifest.files) {
    const projected = {
      path: file.path.slice(0, 1_000),
      ...(file.previousPath
        ? { previousPath: file.previousPath.slice(0, 1_000) }
        : {}),
      status: file.status,
      ...(file.language ? { language: file.language.slice(0, 100) } : {}),
      additions: file.additions,
      deletions: file.deletions,
      ...(file.changedSymbols?.length
        ? {
            changedSymbols: file.changedSymbols
              .slice(0, 20)
              .map((symbol) => symbol.slice(0, 200)),
          }
        : {}),
      ...(file.excludedReason
        ? { excludedReason: file.excludedReason.slice(0, 500) }
        : {}),
    };
    const projectedCharacters = JSON.stringify(projected).length;
    if (serializedCharacters + projectedCharacters > 40_000) {
      continue;
    }
    files.push(projected);
    serializedCharacters += projectedCharacters;
  }

  return {
    baseSha: manifest.baseSha,
    headSha: manifest.headSha,
    mergeBaseSha: manifest.mergeBaseSha,
    fileCount: manifest.files.length,
    omittedFileCount: manifest.files.length - files.length,
    files,
  };
}

function escapeInlineCommentHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "high",
  });

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

  const findingsOutput = pipr.schema({
    id: "review/categorized-findings",
    schema: z.strictObject({
      inlineFindings: z.array(categorizedFindingSchema),
    }),
  });

  const findingsReviewer = pipr.agent({
    name: "findings-reviewer",
    model,
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
    output: findingsOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "10m",
    prompt: () => "Review this change with severity and category metadata.",
  });

  const summaryOutput = pipr.schema({
    id: "review/rich-summary",
    schema: reviewSummarySchema,
  });

  const summaryReviewer = pipr.agent({
    name: "summary-reviewer",
    model,
    instructions: \`
      Make the summary maintainer-facing and scannable: one concrete headline,
      one to four behavior-focused change bullets, a risk level with rationale,
      and reviewer focus only for useful human follow-up. Use the selected
      findings as evidence, but do not invent additional defects or copy
      secret-looking literals into any summary field.
    \`,
    output: summaryOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "10m",
    prompt: ({ inlineFindings, manifestSummary }) =>
      pipr.prompt\`
        Summarize this change using the selected findings.

        \${pipr.section("Scoped compressed manifest", pipr.json(manifestSummary, { maxCharacters: 60_000 }))}

        \${pipr.section("Selected findings", pipr.json(inlineFindings, { maxCharacters: 60_000 }))}
      \`,
  });

  const task = pipr.task({
    name: "review",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(findingsReviewer, { manifest });
      const selectedFindings = deduplicateFindings(
        result.inlineFindings.filter((finding) => hasCommentableAnchor(finding, manifest)),
      )
        .sort((left, right) => severityRank[left.severity] - severityRank[right.severity])
        .slice(0, 8);
      const summary = await ctx.pi.run(summaryReviewer, {
        manifestSummary: summaryManifest(manifest),
        inlineFindings: selectedFindings,
      });
      const inlineFindings: ReviewFinding[] = selectedFindings.map((finding) => {
        const severity = finding.severity.charAt(0).toUpperCase() + finding.severity.slice(1);
        const category = finding.category.replaceAll("-", " ");
        return {
          body: [
            \`**\${severity} \${category}:** \${escapeInlineCommentHtml(lineText(finding.title))}\`,
            "",
            escapeInlineCommentHtml(finding.body),
            "",
            "<details>",
            "<summary>Rationale</summary>",
            "",
            escapeInlineCommentHtml(finding.rationale),
            "",
            "</details>",
          ].join("\\n"),
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
          \`**\${lineText(summary.headline)}**\`,
          "",
          summaryTable(summary),
          "",
          "## What Changed",
          "",
          bulletList(summary.changeSummary, "No changed behavior summarized."),
          "",
          "## Reviewer Focus",
          "",
          bulletList(summary.reviewerFocus, "No special reviewer focus."),
          "",
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr review", permission: "write", task });
});

function summaryTable(summary: ReviewSummary): string {
  return [
    "| Risk | Risk summary |",
    "| --- | --- |",
    \`| \${labelValue(summary.riskLevel)} | \${tableCell(
      summary.riskSummary,
    )} |\`,
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
  return value.replace(/\\r\\n?|\\n/g, " ").trim();
}

function tableCell(value: string): string {
  return lineText(value).replaceAll("|", "\\\\|");
}
`,
} as const satisfies OfficialInitRecipe;
