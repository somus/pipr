import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const reviewer = pipr.reviewer({
    name: "reviewer",
    model,
    instructions: `
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    `,
  });

  pipr.config({ publication: { maxInlineComments: 5 } });

  pipr.review({
    id: "review",
    reviewer,
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: { pattern: "@pipr review", permission: "write" },
    },
    timeout: "5m",
    comment: (result, context) => ({
      main:
        context.platform.id === "local"
          ? [
              "## Summary",
              "",
              result.summary.body,
              "",
              "## Inline Findings",
              "",
              result.inlineFindings.length === 0
                ? "No inline findings."
                : result.inlineFindings.map((finding) => `- ${finding.body}`).join("\n"),
            ].join("\n")
          : result.summary.body,
      inlineFindings: result.inlineFindings,
    }),
  });
});
