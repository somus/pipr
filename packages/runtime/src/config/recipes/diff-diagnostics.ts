import type { OfficialInitRecipe } from "./types.js";

export const diffDiagnosticsRecipe = {
  id: "diff-diagnostics",
  title: "Diff Diagnostics",
  description: "reviewdog-style diagnostic review mapped into inline findings.",
  sourceTools: ["reviewdog"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { ReviewFinding } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const diagnosticOutput = pipr.schema({
    id: "diagnostics/reviewdog-style",
    schema: z.strictObject({
      summary: z.string(),
      diagnostics: z.array(z.strictObject({
        body: z.string(),
        path: z.string(),
        rangeId: z.string(),
        side: z.enum(["RIGHT", "LEFT"]),
        startLine: z.number().int().positive(),
        endLine: z.number().int().positive(),
        suggestedFix: z.string().optional(),
      })),
    }),
  });

  const diagnostics = pipr.agent({
    name: "diff-diagnostics",
    model,
    instructions: "Produce diff-scoped diagnostics for actionable defects only.",
    output: diagnosticOutput,
    prompt: () => "Summarize the diff-scoped diagnostics for this change.",
  });

  const task = pipr.task({
    name: "diff-diagnostics",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(diagnostics, { manifest });
      const inlineFindings: ReviewFinding[] = result.diagnostics.map((diagnostic) => ({
        body: diagnostic.body,
        path: diagnostic.path,
        rangeId: diagnostic.rangeId,
        side: diagnostic.side,
        startLine: diagnostic.startLine,
        endLine: diagnostic.endLine,
        ...(diagnostic.suggestedFix ? { suggestedFix: diagnostic.suggestedFix } : {}),
      }));
      await ctx.comment({
        main: result.summary,
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated"], task });
  pipr.command({ pattern: "@pipr diagnostics", permission: "write", task });
});
`,
} as const satisfies OfficialInitRecipe;
