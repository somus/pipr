# Pipr config patterns

Use these patterns when customizing `.pipr/config.ts`.

## CLI commands

| Command                                                                 | Use                                                                                                                                           |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipr init`                                                             | Create `.pipr/config.ts`, `.pipr/package.json`, `.pipr/bun.lock`, `.pipr/tsconfig.json`, `.pipr/.gitignore`, and the default GitHub workflow. |
| `pipr init --github-enterprise-server`                                | Generate a GitHub Enterprise Server workflow with a self-hosted runner and GHES-compatible artifact action.                                |
| `pipr init --adapters <list>`                                           | Generate selected adapter artifacts for `github`, `gitlab`, `azure-devops`, `bitbucket`, `gitea`, `forgejo`, or `codeberg`; use `none` to skip adapter files. |
| `pipr init --minimal`                                                   | Create only `.pipr/config.ts`; editor types come from a repo-root `@usepipr/sdk` install.                                                     |
| `pipr inspect`                                                          | Print models, agents, tasks, commands, tools, publication settings, checks, and limits.                                                       |
| `pipr check`                                                            | Type-load config and validate the runtime plan.                                                                                               |
| `pipr check --require-env`                                              | Also require configured provider env vars.                                                                                                    |
| `pipr review --base <ref>`                                              | Run change-request tasks locally without publishing comments.                                                                                 |
| `pipr dry-run --host <host> --event <path>`                             | Load a native provider event and config without model calls or publication.                                                                   |
| `pipr webhook serve --host <host> --workspace <path> --repository <id>` | Run trusted webhook ingress for GitLab, Azure DevOps, Bitbucket, Gitea, Forgejo, or Codeberg.                                                  |

## Model and review basics

```ts
import { definePipr } from "@usepipr/sdk";

export default definePipr((pipr) => {
  const model = pipr.model("deepseek/deepseek-v4-pro", { thinking: "high" });

  pipr.config({ publication: { maxInlineComments: 5 } });

  pipr.review({
    id: "review",
    model,
    instructions: `
      Review the change request diff for correctness, security,
      maintainability, and test coverage. Return only actionable findings
      that target valid diff ranges.
    `,
    summary: { instructions: "Summarize changed behavior, risk, and reviewer focus." },
    timeout: "10m",
  });
});
```

Use `id` on a model only when two profiles share the same provider and model with different API keys or thinking levels.

Omit `summary` to run only the findings agent.

## Custom findings

Declare extra finding fields with `pipr.finding(...)`. Enum fields rank findings in declaration order and can drive a check gate. Pipr does not hardcode severity or category.

```ts
const finding = pipr.finding({
  title: z.string().max(160),
  severity: z.enum(["critical", "high", "medium", "low"]),
});

pipr.review({
  id: "review",
  model,
  finding,
  instructions: "Assign severity by merge impact.",
  gate: { failOn: { severity: ["critical", "high"] } },
});
```

## Triggers

`pipr.review` defaults to `defaultReviewTriggers`. Override them with `on`:

```ts
pipr.review({
  id: "review",
  model,
  instructions: "Review only actionable defects.",
  on: {
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

Use a final rest capture for free-form command text, and `parse` to map it into task input:

```ts
pipr.task<{ question: string }>({
  name: "ask",
  on: {
    command: {
      pattern: "@pipr ask <question...>",
      permission: "read",
      parse: (args) => ({ question: args.question ?? "" }),
    },
  },
  async run(ctx, input) {
    await ctx.command?.reply(md`You asked: ${input.question}`);
  },
});
```

## Path scopes

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

For custom tasks, pass the same path scope to `ctx.change.diff(...)` and `ctx.pi.run(...)`.

## Custom tasks

Use `pipr.agent` and `pipr.task` with `on` triggers when `pipr.review(...)` is too small.

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

pipr.task({
  name: "security-review",
  on: {
    changeRequest: ["opened", "updated"],
    command: { pattern: "@pipr security", permission: "write" },
  },
  check: { name: "security", required: true },
  async run(ctx) {
    const diff = await ctx.change.diff({ compressed: true });
    const result = await ctx.pi.run(security, { diff });
    const { findings } = ctx.review.select(result.inlineFindings);
    await ctx.comment({
      main: result.summary.body,
      inlineFindings: findings,
    });
  },
});
```

Run independent agents with `ctx.pi.all([{ agent, input }, ...])`. Build comment Markdown with `md`, which escapes interpolated model text.

Task rules:

- Keep config registration synchronous.
- Let Pipr build the Diff Manifest and validate Inline Review Comments.
- Pass the `ctx.change.diff()` value in agent input; Pipr detects it and supplies the Diff Manifest prompt and tools.
- Use `ctx.review.select(...)` before findings drive checks, tables, or later agents.
- Do not repeat change request metadata or generic `suggestedFix` policy in agent instructions; Core supplies both prompt contracts.
- Emit exactly one final output per selected task.
- Use `ctx.command.reply(...)` for command response workflows.
- Use `local: false` only for tasks that should never run through `pipr review`.

## Checks and publication

```ts
pipr.config({
  publication: {
    maxInlineComments: 6,
    autoResolve: {
      enabled: true,
      model,
      instructions:
        "Resolve only when the changed code addresses the finding directly.",
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

A model without `apiKey` reads its provider's standard variable, such as `DEEPSEEK_API_KEY` for `deepseek/...`. Use `pipr.secret(...)` only to read a different variable name, and use only secret names in config:

```ts
const model = pipr.model("deepseek/deepseek-v4-pro", {
  apiKey: pipr.secret({ name: "PIPR_DEEPSEEK_API_KEY" }),
});
```

Config loading fails for a provider without a standard API-key variable unless the model sets `apiKey`. `apiKey: "local"` uses local Pi login credentials and works only for `pipr review`.

For an OpenAI-compatible gateway or local model server, declare it with `pipr.provider(...)` and reference models as `<provider id>/<gateway model id>`. The provider `apiKey` is required and is the default for its models; the id must not reuse a built-in Pi provider id, and `baseUrl` must use `https` unless it points at `localhost`, `127.0.0.1`, or `[::1]`:

```ts
pipr.provider({
  id: "merge",
  api: "openai-completions",
  baseUrl: "https://api-gateway.merge.dev/v1/openai",
  apiKey: pipr.secret({ name: "MERGE_GATEWAY_API_KEY" }),
});
const model = pipr.model("merge/anthropic/claude-sonnet-5-5", { thinking: "high" });
```

The key and prompts go to that `baseUrl`; confirm the endpoint with the user before writing it. When Pi's catalog does not know the gateway model, set `models: { "<gateway model id>": { contextWindow, maxTokens, cost: { input, output } } }` from the gateway's model page so limits and review cost stats are accurate; `cost` is USD per million tokens.

Add secret mappings in the selected code host integration. GitHub uses `.github/workflows/pipr.yml`; GitLab CI uses masked CI/CD variables, while a GitLab Self-Managed webhook runner also sets `GITLAB_API_URL` to its REST v4 root. Azure DevOps Server webhook runners set `AZURE_DEVOPS_COLLECTION_URL` and the matching `AZURE_DEVOPS_API_VERSION`; Azure DevOps Services, Bitbucket, Gitea, Forgejo, and Codeberg webhook runners use their trusted secret stores. Never commit raw provider keys, local `.env` values, or personal credentials.
