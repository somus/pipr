import type { OfficialInitRecipe } from "./types.js";

export const changelogDraftRecipe = {
  id: "changelog-draft",
  title: "Changelog Draft",
  description: "PR-Agent update_changelog-style release note draft as a comment.",
  sourceTools: ["PR-Agent /update_changelog"],
  configTs: `import { definePipr, md, z } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "medium" });

  const changelog = pipr.agent({
    name: "changelog-draft",
    model,
    instructions: \`
      Draft one concise, release-facing changelog entry grounded in changed
      behavior and change request intent. Use category "internal" when there is no
      user-visible effect. Mention breaking behavior only when the repository
      evidence proves it. Do not invent issue IDs, versions, release claims, or
      behavior not supported by the change. Do not edit files.
    \`,
    output: z.strictObject({
      category: z.enum(["added", "changed", "fixed", "removed", "security", "internal"]),
      entry: z.string(),
      rationale: z.string(),
    }),
    prompt: () => "Draft the changelog entry for this change.",
  });

  pipr.task({
    name: "changelog-draft",
    on: {
      changeRequest: ["opened", "updated"],
      command: { pattern: "@pipr changelog", permission: "write" },
    },
    async run(ctx) {
      const diff = await ctx.change.diff({ compressed: true });
      const result = await ctx.pi.run(changelog, { diff });
      await ctx.comment(
        md.blocks(
          md.callout({
            icon: "ℹ️",
            title: "Changelog draft ready",
            body: md\`Category \\\`\${result.category}\\\`.\`,
          }),
          md\`## 🧭 Summary\`,
          md\`\${result.entry}\`,
          md.details("Rationale", md\`\${result.rationale}\`),
        ),
      );
    },
  });
});
`,
} as const satisfies OfficialInitRecipe;
