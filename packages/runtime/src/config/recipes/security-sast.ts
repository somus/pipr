import type { OfficialInitRecipe } from "./types.js";

export const securitySastRecipe = {
  id: "security-sast",
  title: "Security SAST",
  description: "Security review with custom severity and category output.",
  sourceTools: ["Semgrep", "Snyk", "GitHub CodeQL/code scanning"],
  configTs: `import { definePipr } from "@usepipr/sdk";
import type { ReviewFinding } from "@usepipr/sdk";

type SecurityReview = {
  summary: string;
  risks: Array<{
    title: string;
    category: "auth" | "injection" | "secret" | "crypto" | "data-exposure" | "other";
    severity: "low" | "medium" | "high" | "critical";
    rationale: string;
    finding?: ReviewFinding;
  }>;
};

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  const securityOutput = pipr.jsonSchema<SecurityReview>({
    id: "security/sast-review",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "risks"],
      properties: {
        summary: { type: "string" },
        risks: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["title", "category", "severity", "rationale"],
            properties: {
              title: { type: "string" },
              category: {
                type: "string",
                enum: ["auth", "injection", "secret", "crypto", "data-exposure", "other"],
              },
              severity: { type: "string", enum: ["low", "medium", "high", "critical"] },
              rationale: { type: "string" },
              finding: {
                type: "object",
                additionalProperties: false,
                required: ["body", "path", "rangeId", "side", "startLine", "endLine"],
                properties: {
                  body: { type: "string" },
                  path: { type: "string" },
                  rangeId: { type: "string" },
                  side: { type: "string", enum: ["RIGHT", "LEFT"] },
                  startLine: { type: "number" },
                  endLine: { type: "number" },
                  suggestedFix: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  });

  const security = pipr.agent({
    name: "security-sast",
    model,
    instructions: \`
      Review for exploitable security issues only. Focus on auth bypasses,
      injection, unsafe deserialization, secret exposure, cryptography misuse,
      authorization gaps, and data exposure. Do not report hypothetical style issues.
    \`,
    output: securityOutput,
    tools: pipr.tools.readOnly,
    retry: { invalidOutput: 1, transientFailure: 1 },
    prompt: () => pipr.prompt\`
      \${pipr.section("Security review policy", "Return only risks with a concrete attack path.")}
    \`,
  });

  const task = pipr.task({
    name: "security-sast",
    check: { enabled: true, name: "security-sast", required: true },
    async run(ctx) {
      const manifest = await ctx.change.diffManifest({ compressed: true });
      const result = await ctx.pi.run(security, { manifest });
      const inlineFindings = result.risks.flatMap((risk) => (risk.finding ? [risk.finding] : []));
      if (result.risks.some((risk) => risk.severity === "critical" || risk.severity === "high")) {
        ctx.check.fail("High or critical security risk found.");
      } else {
        ctx.check.pass("No high or critical security risks found.");
      }
      await ctx.comment({
        main: result.summary,
        inlineFindings,
      });
    },
  });

  pipr.on.changeRequest({ actions: ["opened", "updated", "reopened", "ready"], task });
  pipr.command({ pattern: "@pipr security", permission: "write", task });
});
`,
} as const satisfies OfficialInitRecipe;
