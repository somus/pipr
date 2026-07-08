import type { OfficialInitRecipe } from "./types.js";

export const fixSuggestionsRecipe = {
  id: "fix-suggestions",
  title: "Fix Suggestions",
  description: "Command-first exact suggested fixes for actionable review improvements.",
  sourceTools: ["Qodo Merge /improve", "GitHub Copilot code review", "Cursor Bugbot"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { ReviewFinding } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 6 } });

  const fixSuggestionSchema = z.strictObject({
    title: z.string(),
    category: z.enum(["correctness", "tests", "maintainability", "typing", "documentation"]),
    body: z.string(),
    path: z.string(),
    rangeId: z.string(),
    side: z.enum(["RIGHT", "LEFT"]),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    suggestedFix: z.string().min(1),
  });

  type FixSuggestion = z.infer<typeof fixSuggestionSchema>;

  const fixSuggestionOutput = pipr.schema({
    id: "review/fix-suggestions",
    schema: z.strictObject({
      summary: z.string(),
      suggestions: z.array(fixSuggestionSchema),
    }),
  });

  const fixer = pipr.agent({
    name: "fix-suggestions",
    model,
    instructions: \`
      Find exact suggested changes for this pull request. Return a suggestion only
      when suggestedFix is a precise replacement for the selected diff range and
      the reviewer can apply it directly. Prioritize correctness, missing tests,
      type safety, and small maintainability improvements. Do not report broad
      refactors, style preferences, or issues without an exact patch.
    \`,
    output: fixSuggestionOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    timeout: "7m",
    prompt: () => "Find exact suggested changes for this pull request.",
  });

  const task = pipr.task({
    name: "fix-suggestions",
    async run(ctx) {
      if (!ctx.command) {
        throw new Error("fix-suggestions is a command-only task");
      }
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(fixer, { manifest });
      const publishableSuggestions = result.suggestions.filter(
        (suggestion) => suggestion.suggestedFix.trim().length > 0,
      );
      const inlineFindings: ReviewFinding[] = publishableSuggestions.map((suggestion) => ({
        body: \`**\${formatCategory(suggestion.category)}:** \${suggestion.title}. \${suggestion.body}\`,
        path: suggestion.path,
        rangeId: suggestion.rangeId,
        side: suggestion.side,
        startLine: suggestion.startLine,
        endLine: suggestion.endLine,
        suggestedFix: suggestion.suggestedFix,
      }));
      await ctx.comment({
        main: [
          "## Fix Suggestions",
          "",
          result.summary,
          "",
          "## Exact Suggested Changes",
          "",
          suggestionsTable(publishableSuggestions),
        ].join("\\n"),
        inlineFindings,
      });
    },
  });

  pipr.command({
    pattern: "@pipr improve",
    permission: "write",
    description: "Find exact suggested fixes for this pull request.",
    task,
  });
});

function suggestionsTable(suggestions: FixSuggestion[]): string {
  if (suggestions.length === 0) {
    return [
      "| Category | Title |",
      "| --- | --- |",
      "| - | No exact suggested fixes found. |",
    ].join("\\n");
  }
  return [
    "| Category | Title |",
    "| --- | --- |",
    ...suggestions.map(
      (suggestion) =>
        \`| \${formatCategory(suggestion.category)} | \${escapeTableCell(suggestion.title)} |\`,
    ),
  ].join("\\n");
}

function formatCategory(category: string): string {
  return category.replaceAll("-", " ").replace(/^./, (char) => char.toUpperCase());
}

function escapeTableCell(value: string): string {
  return value.replaceAll("\\n", " ").replaceAll("|", "\\\\|");
}
`,
} as const satisfies OfficialInitRecipe;
