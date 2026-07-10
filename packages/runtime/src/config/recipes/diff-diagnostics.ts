import type { OfficialInitRecipe } from "./types.js";

export const diffDiagnosticsRecipe = {
  id: "diff-diagnostics",
  title: "Diff Diagnostics",
  description: "reviewdog-style diagnostic review mapped into inline findings.",
  sourceTools: ["reviewdog"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";
import type { DiffManifest, ReviewFinding } from "@usepipr/sdk";

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
    instructions: \`
      Produce short compiler-style diagnostics for actionable defects only.
      State the concrete defect and impact in at most two sentences. Suppress
      style preferences, broad refactors, and diagnostics without exact changed-line anchors.
    \`,
    output: diagnosticOutput,
    prompt: () => "Summarize the diff-scoped diagnostics for this change.",
  });

  const task = pipr.task({
    name: "diff-diagnostics",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(diagnostics, { manifest });
      const filteredDiagnostics = commentableDiagnostics(result.diagnostics, manifest);
      const droppedDiagnosticCount = result.diagnostics.length - filteredDiagnostics.length;
      const inlineFindings: ReviewFinding[] = filteredDiagnostics.map((diagnostic) => ({
        body: diagnostic.body,
        path: diagnostic.path,
        rangeId: diagnostic.rangeId,
        side: diagnostic.side,
        startLine: diagnostic.startLine,
        endLine: diagnostic.endLine,
        ...(diagnostic.suggestedFix ? { suggestedFix: diagnostic.suggestedFix } : {}),
      }));
      await ctx.comment({
        main: [result.summary, omittedDiagnosticsNote(droppedDiagnosticCount)]
          .filter(Boolean)
          .join("\\n\\n"),
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated"], task });
  pipr.command({ pattern: "@pipr diagnostics", permission: "write", task });
});

type Diagnostic = {
  body: string;
  path: string;
  rangeId: string;
  side: "RIGHT" | "LEFT";
  startLine: number;
  endLine: number;
  suggestedFix?: string;
};

function commentableDiagnostics(
  diagnostics: Diagnostic[],
  manifest: DiffManifest,
): Diagnostic[] {
  const seen = new Set<string>();
  return diagnostics.filter((diagnostic) => {
    const validAnchor = manifest.files.some((file) =>
      file.commentableRanges.some(
        (range) =>
          diagnostic.rangeId === range.id &&
          diagnostic.path === range.path &&
          diagnostic.side === range.side &&
          diagnostic.startLine <= diagnostic.endLine &&
          diagnostic.startLine >= range.startLine &&
          diagnostic.endLine <= range.endLine,
      ),
    );
    const key = [
      diagnostic.path,
      diagnostic.rangeId,
      diagnostic.side,
      diagnostic.startLine,
      diagnostic.endLine,
      diagnostic.body,
    ].join("\\n");
    if (!validAnchor || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function omittedDiagnosticsNote(count: number): string {
  if (count === 0) {
    return "";
  }
  const noun = count === 1 ? "diagnostic" : "diagnostics";
  return \`Omitted \${count} \${noun} with an invalid or duplicate anchor.\`;
}
`,
} as const satisfies OfficialInitRecipe;
