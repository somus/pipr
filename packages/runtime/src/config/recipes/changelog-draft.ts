import type { OfficialInitRecipe } from "./types.js";

export const changelogDraftRecipe = {
  id: "changelog-draft",
  title: "Changelog Draft",
  description: "PR-Agent update_changelog-style release note draft as a comment.",
  sourceTools: ["PR-Agent /update_changelog"],
  configTs: `import { definePipr, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "medium" },
  });

  const changelogOutput = pipr.schema({
    id: "release/changelog-draft",
    schema: z.strictObject({
      category: z.enum(["added", "changed", "fixed", "removed", "security", "internal"]),
      entry: z.string(),
      rationale: z.string(),
    }),
  });

  const changelog = pipr.agent({
    name: "changelog-draft",
    model,
    instructions: \`
      Draft one concise, release-facing changelog entry grounded in changed
      behavior and pull request intent. Use category "internal" when there is no
      user-visible effect. Mention breaking behavior only when the repository
      evidence proves it. Do not invent issue IDs, versions, release claims, or
      behavior not supported by the change. Do not edit files.
    \`,
    output: changelogOutput,
    prompt: () => "Draft the changelog entry for this change.",
  });

  const task = pipr.task({
    name: "changelog-draft",
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(changelog, { manifest });
      await ctx.comment(
        [
          \`**Category:** \${result.category}\`,
          "",
          result.entry,
          "",
          "## Rationale",
          result.rationale,
        ].join("\\n"),
      );
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated"], task });
  pipr.command({ pattern: "@pipr changelog", permission: "write", task });
});
`,
} as const satisfies OfficialInitRecipe;
