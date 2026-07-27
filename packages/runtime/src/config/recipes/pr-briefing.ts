import type { OfficialInitRecipe } from "./types.js";

export const prBriefingRecipe = {
  id: "pr-briefing",
  title: "PR Briefing",
  description: "PR-Agent describe-style overview, risk summary, and walkthrough.",
  sourceTools: ["PR-Agent /describe", "CodeRabbit PR summaries"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "medium",
  });

  pipr.config({ publication: { maxInlineComments: 0 } });

  const briefingSchema = z.strictObject({
    summary: z.string(),
    prType: z.enum(["feature", "bugfix", "refactor", "docs", "tests", "dependency", "infra", "mixed"]),
    riskLevel: z.enum(["low", "medium", "high"]),
    riskSummary: z.string(),
    changeMap: z.array(z.strictObject({
      area: z.string(),
      files: z.array(z.string()).max(4),
      change: z.string(),
    })).max(6),
    reviewerFocus: z.array(z.string()).max(4),
    notableFiles: z.array(z.strictObject({
      path: z.string(),
      reason: z.string(),
    })).max(6),
    walkthrough: z.array(z.string()).max(6),
    diagramMermaid: z.string().optional(),
  });

  type Briefing = z.infer<typeof briefingSchema>;

  const briefingOutput = pipr.schema({
    id: "briefing/pr-reviewer",
    schema: briefingSchema,
  });

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
    output: briefingOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "7m",
    prompt: () => "Prepare a maintainer briefing for this change request.",
  });

  const task = pipr.task({
    name: "pr-briefing",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(briefing, { manifest });
      const sections = [
        "## 🧭 Summary",
        "",
        result.summary,
        "",
        metadataTable(result, ctx.change.title),
      ];
      if (result.changeMap.length > 0) {
        sections.push("", "## 🗺️ Change Map", "", changeMapTable(result.changeMap));
      }
      if (result.notableFiles.length > 0) {
        sections.push("", "## Notable Files", "", notableFilesTable(result.notableFiles));
      }
      if (result.walkthrough.length > 0) {
        sections.push(
          "",
          "## Walkthrough",
          "",
          numberedList(result.walkthrough),
        );
      }
      if (result.reviewerFocus.length > 0) {
        sections.push(
          "",
          "## 🎯 Reviewer Focus",
          "",
          bulletList(result.reviewerFocus),
        );
      }
      const diagram = diagramBlock(result.diagramMermaid);
      if (diagram) {
        sections.push("", diagram);
      }
      await ctx.comment(sections.join("\\n"));
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({
    pattern: "@pipr describe",
    permission: "read",
    description: "Generate a reviewer briefing for this change request.",
    task,
  });
});

function metadataTable(briefing: Briefing, title: string): string {
  const prType = briefing.prType.replaceAll("-", " ").replace(/^./, (char) => char.toUpperCase());
  const riskLevel = briefing.riskLevel
    .replaceAll("-", " ")
    .replace(/^./, (char) => char.toUpperCase());
  return [
    "| Metadata | Value |",
    "| --- | --- |",
    \`| Change | \${tableCell(title)} |\`,
    \`| Type | \${prType} |\`,
    \`| Review risk | \${riskLevel} |\`,
    \`| Risk summary | \${tableCell(briefing.riskSummary)} |\`,
  ].join("\\n");
}

function changeMapTable(changeMap: Briefing["changeMap"]): string {
  return [
    "| Area | Files | Change |",
    "| --- | --- | --- |",
    ...changeMap.map((item) => {
      const area = tableCell(item.area);
      const files = item.files.map((file) => tableCell(inlineCode(file))).join("<br>");
      const change = tableCell(item.change);
      return \`| \${area} | \${files} | \${change} |\`;
    }),
  ].join("\\n");
}

function notableFilesTable(files: Briefing["notableFiles"]): string {
  return [
    "| File | Why it matters |",
    "| --- | --- |",
    ...files.map((file) => {
      const filePath = tableCell(inlineCode(file.path));
      const reason = tableCell(file.reason);
      return \`| \${filePath} | \${reason} |\`;
    }),
  ].join("\\n");
}

function bulletList(items: string[]): string {
  return items.map((item) => \`- \${lineText(item)}\`).join("\\n");
}

function numberedList(items: string[]): string {
  return items.map((item, index) => \`\${index + 1}. \${lineText(item)}\`).join("\\n");
}

function tableCell(value: string): string {
  return lineText(value).replaceAll("|", "\\\\|");
}

function inlineCode(value: string): string {
  const text = lineText(value);
  const longestBacktickRun = Math.max(
    0,
    ...[...text.matchAll(/\`+/g)].map((match) => match[0].length),
  );
  const fence = "\`".repeat(longestBacktickRun + 1);
  const padding = text.startsWith("\`") || text.endsWith("\`") ? " " : "";
  return fence + padding + text + padding + fence;
}

function lineText(value: string): string {
  return value.replace(/\\r\\n?|\\n/g, " ").trim();
}

function diagramBlock(diagramMermaid: string | undefined): string {
  const diagram = diagramMermaid?.trim();
  if (!diagram) {
    return "";
  }
  const fence = markdownFenceFor(diagram);
  return [
    "<details>",
    "<summary>Flow diagram</summary>",
    "",
    \`\${fence}mermaid\`,
    diagram,
    fence,
    "",
    "</details>",
  ].join("\\n");
}

function markdownFenceFor(value: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...[...value.matchAll(/\`+/g)].map((match) => match[0].length),
  );
  return "\`".repeat(Math.max(3, longestBacktickRun + 1));
}
`,
} as const satisfies OfficialInitRecipe;
