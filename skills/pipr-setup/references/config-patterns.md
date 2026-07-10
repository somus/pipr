# Pipr Config Patterns

Use these patterns when customizing `.pipr/config.ts`.

## CLI Commands

| Command | Use |
| --- | --- |
| `pipr init` | Create `.pipr/config.ts`, `.pipr/package.json`, `.pipr/bun.lock`, `.pipr/tsconfig.json`, `.pipr/.gitignore`, and the GitHub workflow. |
| `pipr init --minimal` | Create only `.pipr/config.ts`; editor types come from a repo-root `@usepipr/sdk` install. |
| `pipr inspect` | Print models, agents, tasks, commands, tools, publication settings, checks, and limits. |
| `pipr check` | Type-load config and validate the runtime plan. |
| `pipr check --require-env` | Also require configured provider env vars. |
| `pipr review --base <ref>` | Run change-request tasks locally without publishing comments. |
| `pipr dry-run --event <path>` | Load a GitHub event and config without model calls or publication. |

## Model And Review Basics

```ts
import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model({
    provider: "deepseek",
    model: "deepseek-v4-pro",
    apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" }),
    options: { thinking: "high" },
  });

  pipr.config({ publication: { maxInlineComments: 5 } });

  pipr.review({
    id: "review",
    model,
    instructions: `
      Review the pull request diff for correctness, security,
      maintainability, and test coverage.
      Return only actionable findings that target valid diff ranges.
    `,
    timeout: "10m",
  });
});
```

Use `id` on a model only when two model profiles share the same provider and model with different options.

## Entrypoints

```ts
pipr.review({
  id: "review",
  model,
  instructions: "Review only actionable defects.",
  entrypoints: {
    changeRequest: ["opened", "updated", "reopened", "ready"],
    command: { pattern: "@pipr review", permission: "write" },
  },
});
```

Supported public change request actions:

```text
opened | updated | reopened | ready | closed
```

Command permissions:

```text
read < triage < write < maintain < admin
```

Use a final rest capture for free-form command text:

```ts
pipr.command({ pattern: "@pipr ask <question...>", permission: "read", task });
```

## Path Scopes

Use `paths` to filter the Diff Manifest and publishable Inline Review Comments:

```ts
pipr.review({
  id: "runtime-review",
  model,
  instructions: "Review runtime changes only.",
  paths: {
    include: ["packages/runtime/**"],
    exclude: ["**/*.test.ts"],
  },
});
```

For custom tasks, pass the same path scope to `ctx.change.diffManifest(...)` and `ctx.pi.run(...)`.

## Custom Tasks

Use `pipr.agent`, `pipr.task`, and `pipr.on.changeRequest` when `pipr.review(...)` is too small.

```ts
const security = pipr.agent({
  name: "security-reviewer",
  model,
  instructions: "Review only concrete security issues.",
  output: pipr.schemas.review,
  tools: pipr.tools.readOnly,
  prompt: () => pipr.prompt`
    ${pipr.section("Policy", "Return only findings with a concrete attack path.")}
  `,
});

const task = pipr.task({
  name: "security-review",
  check: { name: "security", required: true },
  async run(ctx) {
    const manifest = await ctx.change.diffManifest({ compressed: true });
    const result = await ctx.pi.run(security, { manifest });
    await ctx.comment({ main: result.summary.body, inlineFindings: result.inlineFindings });
  },
});

pipr.on.changeRequest({ actions: ["opened", "updated"], task });
pipr.command({ pattern: "@pipr security", permission: "write", task });
```

Task rules:

- Keep config registration synchronous.
- Let Pipr build the Diff Manifest and validate Inline Review Comments.
- Pass the Diff Manifest through the reserved `manifest` input key.
- Do not repeat change request metadata or generic `suggestedFix` policy in agent instructions; Core supplies both prompt contracts.
- Emit exactly one final output per selected task.
- Use `ctx.command.reply(...)` for command response workflows.
- Use `local: false` only for tasks that should never run through `pipr review`.

## Checks And Publication

```ts
pipr.config({
  publication: {
    maxInlineComments: 6,
    autoResolve: {
      enabled: true,
      model,
      instructions: "Resolve only when the changed code addresses the finding directly.",
      synchronize: true,
      userReplies: { enabled: true, allowedActors: "write" },
    },
  },
  checks: {
    aggregate: { enabled: true, name: "pipr quality gate" },
  },
});
```

Use required checks only when the user wants merge-gate behavior. Use comments for reviewer-facing detail.

## Secrets

Use only secret names in config:

```ts
apiKey: pipr.secret({ name: "DEEPSEEK_API_KEY" })
```

Add matching GitHub Actions secret mappings in `.github/workflows/pipr.yml`. Never commit raw provider keys, local `.env` values, or personal credentials.
