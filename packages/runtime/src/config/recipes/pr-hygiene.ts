import type { OfficialInitRecipe } from "./types.js";

export const prHygieneRecipe = {
  id: "pr-hygiene",
  title: "PR Hygiene",
  description: "Danger-style PR hygiene checks for tests, docs, lockfiles, and size.",
  sourceTools: ["Danger JS"],
  configTs: `import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "medium" },
  });

  const hygiene = pipr.agent({
    name: "pr-hygiene",
    model,
    instructions: \`
      Review pull request hygiene. Check whether behavior changes include tests,
      public API changes include docs or changelog notes, lockfile changes match manifests,
      and the PR size is reasonable. Return concise actionable findings.
    \`,
    output: pipr.schemas.review,
    prompt: (input: { manifest: unknown; changedFiles: unknown }) => pipr.prompt\`
      \${pipr.section("Changed files", pipr.json(input.changedFiles, { maxCharacters: 20000 }))}
    \`,
  });

  const task = pipr.task({
    name: "pr-hygiene",
    check: { enabled: true, name: "pr hygiene", required: false },
    async run(ctx) {
      const changedFiles = await ctx.change.changedFiles();
      ctx.log.info(\`Checking PR hygiene for \${changedFiles.length} changed file(s).\`);
      const manifest = await ctx.change.diffManifest({ compressed: true, maxPreviewLines: 80 });
      const result = await ctx.pi.run(hygiene, { manifest, changedFiles });
      ctx.check.pass("PR hygiene review completed.");
      await ctx.comment({
        main: result.summary.body,
        inlineFindings: result.inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr hygiene", permission: "write", task });
});
`,
} as const satisfies OfficialInitRecipe;
