# Pipr

[![CI](https://github.com/somus/pipr/actions/workflows/ci.yml/badge.svg)](https://github.com/somus/pipr/actions/workflows/ci.yml)

Pipr is a Pi-powered code review runtime. It loads a repository-local TypeScript config, builds a deterministic Diff Manifest, runs Pi for structured review output, validates findings against commentable ranges, and publishes one Main Review Comment plus capped Inline Review Comments.

GitHub is the first delivery target. Internally, GitHub is a code host adapter, so `.pipr/config.ts` stays provider-neutral. GitLab, Bitbucket, and Azure DevOps support is coming soon.

## Why Pipr

Every code review tool excels at something different: one finds security issues, another writes PR summaries, another gates merges. Getting all of that means running several bots on every pull request, with overlapping comments, duplicated model spend, and no single place to control the policy.

Pipr takes the Pi approach: a lean core plus the building blocks to compose what you need. The runtime owns the hard, safety-critical parts — diff modeling, Pi agent execution, structured output validation, and comment publishing. Everything on top is TypeScript you own:

- `pipr.review(...)` for a tuned default review
- `pipr init --recipe <id>` starters for security SAST, PR briefings, quality gates, dependency risk, and more
- `pipr.task(...)` and `pipr.agent(...)` for custom workflows with typed schemas
- `pipr.command(...)` for `@pipr` commands
- `definePlugin(...)` for typed tools agents can call during review

One config, one run, one validated comment pipeline — instead of a stack of single-purpose review tools.

## Quickstart

Create the TypeScript config and default GitHub Action workflow:

```bash
curl -fsSL https://raw.githubusercontent.com/somus/pipr/main/install.sh | sh
pipr init
pipr check
```

AI agents should load the version-matched setup skill before configuring a repository:

```bash
pipr skill
```

Use `pipr init --adapters none` to create only `.pipr` config files. Run
`pipr init --help` to list supported init adapters.

Set the provider secret used by the default config:

```bash
DEEPSEEK_API_KEY=...
```

`pipr init` creates `.github/workflows/pipr.yml`:

```yaml
name: pipr

on:
  pull_request:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  contents: write
  pull-requests: write
  issues: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0
      - uses: somus/pipr@v0.2.2 # x-release-please-version
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

See [Docs](https://pipr.run/docs) or
[Quickstart](https://pipr.run/docs/guide/quickstart) for the full first-run
path.

## Remote Cache

CI and release workflows read Turborepo remote cache settings from GitHub:

```bash
gh secret set TURBO_API
gh secret set TURBO_TOKEN
gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY
gh variable set TURBO_TEAM --body pipr
```

`TURBO_API` should point at a deployed `ducktors/turborepo-remote-cache` server. To run that server locally:

```bash
cp turbo-cache.env.example turbo-cache.env
docker compose --env-file turbo-cache.env -f docker-compose.turbo-cache.yml up -d
```

## Configuration

`pipr init` creates `.pipr/config.ts`:

```ts
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
    timeout: "10m",
  });
});
```

The SDK also supports custom agents, tasks, `@pipr` commands, model fallback, local-disabled tasks, and retry settings. See [Configuration](https://pipr.run/docs/guide/configuration).

## Docs

- [Docs home](https://pipr.run/docs)
- [Guide](https://pipr.run/docs/guide)
- [Recipes](https://pipr.run/docs/recipes)
- [Quickstart](https://pipr.run/docs/guide/quickstart)
- [Configuration](https://pipr.run/docs/guide/configuration)
- [Entrypoints](https://pipr.run/docs/guide/entrypoints)
- [Custom Tasks](https://pipr.run/docs/guide/custom-tasks)
- [Pipr SDK Reference](https://pipr.run/docs/reference/sdk-reference)
- [Runtime Guide](https://pipr.run/docs/guide/runtime)
- [Comments and Findings](https://pipr.run/docs/guide/comments)
- [GitHub Action](https://pipr.run/docs/guide/github-action)
- [Code Host Adapters](https://pipr.run/docs/reference/code-host-adapters)
- [Architecture](https://pipr.run/docs/reference/architecture)
- [Development](https://pipr.run/docs/reference/development)
- [Product language](docs/CONTEXT.md)
- [Architecture decisions](docs/adr)

## Status

Pipr is early. CLI binaries ship through GitHub Releases, `@usepipr/sdk`, `@usepipr/runtime`, and `@usepipr/cli` ship through npm, and the Docker Action image ships through GHCR.

## Privacy

Pipr runs in your local environment or CI runner. This repo does not use a hosted Pipr control plane.

When a review runs, Pipr may send the configured model provider:

- repository and change request metadata needed for the review
- task instructions from the trusted `.pipr/config.ts`
- the Diff Manifest, including changed file paths, hunks, commentable ranges, and bounded code previews
- bounded Diff Read Tool responses when the manifest is condensed

Provider API keys are read from environment variables such as `DEEPSEEK_API_KEY`. `pipr.secret({ name })` stores the variable name in the runtime plan, not the secret value.

On GitHub, Pipr uses `GITHUB_TOKEN` to read pull request metadata, publish the Main Review Comment and Inline Review Comments, and resolve review threads for fixed findings. Published comments become part of the repository's normal GitHub pull request record. Local runs do not publish comments.

Do not run Pipr on code you are not permitted to send to the configured model provider.

## License

MIT
