import type { OfficialInitRecipe } from "./types.js";

export const ciTriageCommandRecipe = {
  id: "ci-triage-command",
  title: "CI Triage Command",
  description: "Command-only CI failure triage from a pasted log excerpt.",
  sourceTools: ["CodeRabbit"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    thinking: "high",
  });

  const ciTriageOutput = pipr.schema({
    id: "ci/triage",
    schema: z.strictObject({
      status: z.enum(["diagnosed", "insufficient-context"]),
      summary: z.string(),
      evidence: z.array(z.string()).max(4),
      likelyCauses: z.array(z.string()).max(3),
      nextSteps: z.array(z.string()).max(4),
    }),
  });

  const ciTriage = pipr.agent({
    name: "ci-triage",
    model,
    instructions: \`
      Diagnose CI failures using only the pasted log excerpt, change request
      metadata, prior review state, and repository evidence. Identify the first
      actionable failure and separate it from downstream cascade errors. Use
      status "insufficient-context" when the excerpt cannot support a diagnosis.
      Do not infer a cause from a final exit code alone.
    \`,
    output: ciTriageOutput,
    prompt: (input: { log: string; manifest: unknown; prior: unknown }) => pipr.prompt\`
      \${pipr.section("CI log excerpt", input.log)}
      \${pipr.section("Prior pipr review", pipr.json(input.prior, { maxCharacters: 20000 }))}
    \`,
  });

  const task = pipr.task<{ log: string }>({
    name: "ci-triage",
    async run(ctx, input) {
      if (!ctx.command) {
        throw new Error("ci-triage is a command-only task");
      }
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const prior = await ctx.review.prior();
      const result = await ctx.pi.run(ciTriage, { log: input.log, manifest, prior });
      await ctx.command.reply(ciTriageComment(result));
    },
  });

  pipr.command({
    pattern: "@pipr ci <log...>",
    permission: "write",
    description: "Triage a pasted CI failure log.",
    parse: (args) => ({ log: args.log ?? "" }),
    task,
  });
});

type CiTriageResult = {
  status: "diagnosed" | "insufficient-context";
  summary: string;
  evidence: string[];
  likelyCauses: string[];
  nextSteps: string[];
};

function ciTriageComment(result: CiTriageResult): string {
  const sections = [
    "## CI Triage",
    "",
    "**Status:** " + labelValue(result.status),
    "",
    result.summary,
  ];
  appendList(sections, "Evidence", result.evidence);
  appendList(sections, "Likely Causes", result.likelyCauses);
  appendList(sections, "Next Steps", result.nextSteps);
  return sections.join("\\n");
}

function appendList(sections: string[], title: string, items: string[]): void {
  if (items.length === 0) {
    return;
  }
  sections.push("", "## " + title, "", ...items.map((item) => "- " + item));
}

function labelValue(value: string): string {
  return value.replaceAll("-", " ").replace(/^./, (char) => char.toUpperCase());
}
`,
} as const satisfies OfficialInitRecipe;
