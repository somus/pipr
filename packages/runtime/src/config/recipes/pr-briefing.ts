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
    options: { thinking: "medium" },
  });

  pipr.config({ publication: { maxInlineComments: 0 } });

  const briefingSchema = z.strictObject({
    summary: z.string(),
    prType: z.enum(["feature", "bugfix", "refactor", "docs", "tests", "dependency", "infra", "mixed"]),
    riskLevel: z.enum(["low", "medium", "high"]),
    riskSummary: z.string(),
    changeMap: z.array(z.strictObject({
      area: z.string(),
      files: z.array(z.string()).max(6),
      change: z.string(),
    })).max(8),
    reviewerFocus: z.array(z.string()).max(6),
    notableFiles: z.array(z.strictObject({
      path: z.string(),
      reason: z.string(),
    })).max(8),
    walkthrough: z.array(z.string()).max(8),
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
      straightforward changes. Do not report inline findings.
    \`,
    output: briefingOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "7m",
    prompt: () => "Prepare a maintainer briefing for this pull request.",
  });

  const task = pipr.task({
    name: "pr-briefing",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(briefing, { manifest, change: ctx.change });
      await ctx.comment([
        "## PR Briefing",
        "",
        overviewTable(result, ctx.change.title),
        "",
        "## Summary",
        "",
        result.summary,
        "",
        "## Change Map",
        "",
        changeMapTable(result.changeMap),
        "",
        "## Reviewer Focus",
        "",
        bulletList(result.reviewerFocus, "No special reviewer focus called out."),
        "",
        "## Notable Files",
        "",
        notableFilesTable(result.notableFiles),
        "",
        "## Walkthrough",
        "",
        bulletList(result.walkthrough, "No walkthrough notes."),
        "",
        diagramBlock(result.diagramMermaid),
      ].filter(Boolean).join("\\n"));
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({
    pattern: "@pipr describe",
    permission: "read",
    description: "Generate a reviewer briefing for this pull request.",
    task,
  });
});

function overviewTable(briefing: Briefing, title: string): string {
  return [
    "| Change | Type | Risk | Risk summary |",
    "| --- | --- | --- | --- |",
    \`| \${escapeTableCell(title)} | \${formatLabel(briefing.prType)} | \${formatLabel(
      briefing.riskLevel,
    )} | \${escapeTableCell(briefing.riskSummary)} |\`,
  ].join("\\n");
}

function changeMapTable(changeMap: Briefing["changeMap"]): string {
  if (changeMap.length === 0) {
    return [
      "| Area | Files | Change |",
      "| --- | --- | --- |",
      "| - | - | No changed areas summarized. |",
    ].join("\\n");
  }
  return [
    "| Area | Files | Change |",
    "| --- | --- | --- |",
    ...changeMap.map(
      (item) =>
        \`| \${escapeTableCell(item.area)} | \${escapeTableCell(
          item.files.join("<br>"),
        )} | \${escapeTableCell(item.change)} |\`,
    ),
  ].join("\\n");
}

function notableFilesTable(files: Briefing["notableFiles"]): string {
  if (files.length === 0) {
    return [
      "| File | Why it matters |",
      "| --- | --- |",
      "| - | No notable files called out. |",
    ].join("\\n");
  }
  return [
    "| File | Why it matters |",
    "| --- | --- |",
    ...files.map((file) => \`| \${escapeTableCell(file.path)} | \${escapeTableCell(file.reason)} |\`),
  ].join("\\n");
}

function bulletList(items: string[], emptyText: string): string {
  if (items.length === 0) {
    return emptyText;
  }
  return items.map((item) => \`- \${item}\`).join("\\n");
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

function formatLabel(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (char) => char.toUpperCase());
}

function escapeTableCell(value: string): string {
  return value.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
}
`,
} as const satisfies OfficialInitRecipe;
