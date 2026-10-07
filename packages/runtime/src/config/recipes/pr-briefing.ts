import type { OfficialInitRecipe } from "./types.js";

export const prBriefingRecipe = {
  id: "pr-briefing",
  title: "PR Briefing",
  description: "PR-Agent describe-style overview, risk summary, and walkthrough.",
  sourceTools: ["PR-Agent /describe", "CodeRabbit PR summaries"],
  configTs: `import { defaultReviewActions, definePipr, md, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "medium" });

  pipr.config({ publication: { maxInlineComments: 0 } });

  const briefing = pipr.agent({
    name: "pr-briefing",
    model,
    instructions: \`
      Produce a maintainer briefing instead of a defect hunt. Summarize what changed,
      classify the PR type, explain review risk, list notable files, and include
      a concise reviewer walkthrough. Use reviewerFocus for what humans should
      inspect first. Use diagramMermaid only when a small flowchart clarifies
      multi-step control flow, data flow, or package boundaries; omit it for
      straightforward changes. Ground every file and claim in the Diff Manifest
      and change metadata. Walkthrough items must explain behavior flow rather
      than repeat file lists. Return empty arrays for list sections with no useful content;
      the renderer omits those empty sections. Do not report inline findings.
    \`,
    output: z.strictObject({
      summary: z.string(),
      prType: z.enum(["feature", "bugfix", "refactor", "docs", "tests", "dependency", "infra", "mixed"]),
      riskLevel: z.enum(["low", "medium", "high"]),
      riskSummary: z.string(),
      changeMap: z
        .array(z.strictObject({ area: z.string(), files: z.array(z.string()).max(4), change: z.string() }))
        .max(6),
      reviewerFocus: z.array(z.string()).max(4),
      notableFiles: z.array(z.strictObject({ path: z.string(), reason: z.string() })).max(6),
      walkthrough: z.array(z.string()).max(6),
      diagramMermaid: z.string().optional(),
    }),
    tools: pipr.tools.readOnly,
    timeout: "7m",
    prompt: () => "Prepare a maintainer briefing for this change request.",
  });

  pipr.task({
    name: "pr-briefing",
    on: {
      changeRequest: defaultReviewActions,
      command: {
        pattern: "@pipr describe",
        permission: "read",
        description: "Generate a reviewer briefing for this change request.",
      },
    },
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true });
      const result = await ctx.pi.run(briefing, { diff });
      await ctx.comment(
        md.blocks(
          md\`## 🧭 Summary\`,
          md\`\${result.summary}\`,
          md.table(
            [
              { metadata: "Change", value: ctx.change.title },
              { metadata: "Type", value: md.label(result.prType) },
              { metadata: "Review risk", value: md.label(result.riskLevel) },
              { metadata: "Risk summary", value: result.riskSummary },
            ],
            { metadata: "Metadata", value: "Value" },
          ),
          result.changeMap.length > 0 ? md\`## 🗺️ Change Map\` : "",
          md.table(
            result.changeMap.map((item) => ({
              area: item.area,
              files: md.raw(item.files.map(inlineCode).join("<br>")),
              change: item.change,
            })),
            { area: "Area", files: "Files", change: "Change" },
          ),
          result.notableFiles.length > 0 ? md\`## Notable Files\` : "",
          md.table(
            result.notableFiles.map((file) => ({ file: md.raw(inlineCode(file.path)), reason: file.reason })),
            { file: "File", reason: "Why it matters" },
          ),
          result.walkthrough.length > 0 ? md\`## Walkthrough\` : "",
          md.list(result.walkthrough, { ordered: true }),
          result.reviewerFocus.length > 0 ? md\`## 🎯 Reviewer Focus\` : "",
          md.list(result.reviewerFocus),
          result.diagramMermaid?.trim()
            ? md.details("Flow diagram", fenced("mermaid", result.diagramMermaid))
            : "",
        ),
      );
    },
  });
});

function longestBacktickRun(value: string): number {
  return Math.max(0, ...[...value.matchAll(/\`+/g)].map((match) => match[0].length));
}

function inlineCode(value: string): string {
  const text = value.replace(/\\s+/g, " ").trim();
  const fence = "\`".repeat(longestBacktickRun(text) + 1);
  const padding = text.startsWith("\`") || text.endsWith("\`") ? " " : "";
  return fence + padding + text + padding + fence;
}

function fenced(language: string, value: string) {
  const text = value.trim();
  const fence = "\`".repeat(Math.max(3, longestBacktickRun(text) + 1));
  return md.raw(\`\${fence}\${language}\\n\${text}\\n\${fence}\`);
}
`,
} as const satisfies OfficialInitRecipe;
