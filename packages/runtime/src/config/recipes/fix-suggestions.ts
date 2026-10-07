import type { OfficialInitRecipe } from "./types.js";

export const fixSuggestionsRecipe = {
  id: "fix-suggestions",
  title: "Fix Suggestions",
  description: "Command-first exact suggested fixes for actionable review improvements.",
  sourceTools: ["Qodo Merge /improve", "GitHub Copilot code review", "Cursor Bugbot"],
  configTs: `import { definePipr, md, z } from "@usepipr/sdk";
import type { DiffContext } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  pipr.config({ publication: { maxInlineComments: 6 } });

  const fixSuggestion = pipr.finding({
    title: z.string(),
    category: z.enum(["correctness", "tests", "typing", "maintainability", "documentation"]),
  });

  type FixSuggestion = z.infer<typeof fixSuggestion>;

  const fixer = pipr.agent({
    name: "fix-suggestions",
    model,
    instructions: \`
      Find directly applicable fixes for this change request. Return an item only
      when an exact suggestedFix patch can resolve the reported defect; otherwise
      omit the entire item. Prioritize correctness, missing tests, type safety,
      and small maintainability improvements. Do not report broad refactors,
      style preferences, or issues without an exact patch.
    \`,
    output: pipr.schema({
      id: "review/fix-suggestions",
      schema: z.strictObject({ suggestions: z.array(fixSuggestion) }),
    }),
    tools: pipr.tools.readOnly,
    timeout: "7m",
    prompt: (_input: { diff: DiffContext }) => "Find exact suggested changes for this change request.",
  });

  const verifier = pipr.agent({
    name: "fix-suggestion-verifier",
    model,
    instructions: \`
      Semantically verify candidate fixes after deterministic range validation.
      Accept a candidate only when the defect is real and introduced or exposed
      by the change, the body and replacement address the same defect, the exact
      replacement preserves surrounding contracts, and no secret or config
      dependency is invented. Reject speculative, style-only, or broad changes.
      Return one verdict for every supplied candidate index and never invent indexes.
    \`,
    output: pipr.schema({
      id: "review/fix-suggestion-verification",
      schema: z.strictObject({
        verdicts: z.array(
          z.strictObject({
            index: z.number().int().nonnegative(),
            accepted: z.boolean(),
            reason: z.string(),
          }),
        ),
      }),
    }),
    tools: pipr.tools.readOnly,
    timeout: "7m",
    prompt: (input: { diff: DiffContext; candidates: readonly FixSuggestion[] }) => pipr.prompt\`
      \${pipr.section("Candidate suggestions", pipr.json(input.candidates, { maxCharacters: 60000 }))}
    \`,
  });

  pipr.task({
    name: "fix-suggestions",
    on: {
      command: {
        pattern: "@pipr improve",
        permission: "write",
        description: "Find exact suggested fixes for this change request.",
      },
    },
    async run(ctx) {
      if (!ctx.command) {
        throw new Error("fix-suggestions is a command-only task");
      }
      const diff = await ctx.change.diff({ compressed: true });
      const result = await ctx.pi.run(fixer, { diff });
      const { findings: candidates } = ctx.review.select(result.suggestions, {
        finding: fixSuggestion,
        requireSuggestedFix: true,
      });
      const accepted =
        candidates.length === 0
          ? []
          : acceptedSuggestions(candidates, (await ctx.pi.run(verifier, { diff, candidates })).verdicts);
      await ctx.comment({
        main: md.blocks(
          md\`## 🧭 Summary\`,
          suggestionSummary(accepted.length),
          accepted.length > 0 ? md\`## 🛠️ Exact Suggested Changes\` : "",
          accepted.length > 0
            ? md.table(
                accepted.map((suggestion) => ({
                  category: md.label(suggestion.category),
                  title: suggestion.title,
                })),
                { category: "Category", title: "Title" },
              )
            : "",
        ),
        inlineFindings: accepted.map((suggestion) => ({
          ...suggestion,
          body: String(
            md\`**\${md.label(suggestion.category)}:** \${suggestion.title}. \${md.raw(suggestion.body)}\`,
          ),
        })),
      });
    },
  });
});

function acceptedSuggestions<T>(
  candidates: readonly T[],
  verdicts: { index: number; accepted: boolean }[],
): T[] {
  const counts = new Map<number, number>();
  for (const verdict of verdicts) {
    counts.set(verdict.index, (counts.get(verdict.index) ?? 0) + 1);
  }
  return candidates.filter(
    (_, index) =>
      counts.get(index) === 1 &&
      verdicts.some((verdict) => verdict.index === index && verdict.accepted),
  );
}

function suggestionSummary(count: number): string {
  if (count === 0) {
    return "No exact suggested changes passed validation.";
  }
  return count + " exact suggested " + (count === 1 ? "change" : "changes") + " passed validation.";
}
`,
} as const satisfies OfficialInitRecipe;
