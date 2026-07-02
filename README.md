# Pipr

[![CI](https://github.com/somus/pipr/actions/workflows/ci.yml/badge.svg)](https://github.com/somus/pipr/actions/workflows/ci.yml)

Pipr is a Pi-powered code review runtime. It loads a repository-local TypeScript config, builds a deterministic Diff Manifest, runs Pi for structured review output, validates findings against commentable ranges, and publishes one Main Review Comment plus capped Inline Review Comments.

GitHub is the first delivery target. Internally, GitHub is a code host adapter, so `.pipr/config.ts` stays provider-neutral. GitLab, Bitbucket, and Azure DevOps support is coming soon.

## Quickstart

Create the TypeScript config and default GitHub Action workflow:

```bash
curl -fsSL https://raw.githubusercontent.com/somus/pipr/main/install.sh | sh
pipr init
pipr check
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
      - uses: somus/pipr@v0.1.1 # x-release-please-version
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

See [Docs](apps/docs/content/docs/index.mdx) or [Quickstart](apps/docs/content/docs/guide/quickstart.mdx) for the full first-run path.

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

  pipr.review({
    id: "review",
    reviewer,
    entrypoints: {
      changeRequest: ["opened", "updated", "reopened", "ready"],
      command: { pattern: "@pipr review", permission: "write" },
    },
    inlineComments: { max: 5 },
    timeout: "5m",
  });
});
```

The SDK also supports custom agents, tasks, `@pipr` commands, model fallback, local-disabled tasks, and retry settings. See [Configuration](apps/docs/content/docs/guide/configuration.mdx).

## Docs

- [Docs home](apps/docs/content/docs/index.mdx)
- [Guide](apps/docs/content/docs/guide/index.mdx)
- [Recipes](apps/docs/content/docs/recipes/index.mdx)
- [Quickstart](apps/docs/content/docs/guide/quickstart.mdx)
- [Configuration](apps/docs/content/docs/guide/configuration.mdx)
- [Entrypoints](apps/docs/content/docs/guide/entrypoints.mdx)
- [Custom Tasks](apps/docs/content/docs/guide/custom-tasks.mdx)
- [Pipr SDK Reference](apps/docs/content/docs/reference/sdk-reference.mdx)
- [Runtime Guide](apps/docs/content/docs/guide/runtime.mdx)
- [Comments and Findings](apps/docs/content/docs/guide/comments.mdx)
- [GitHub Action](apps/docs/content/docs/guide/github-action.mdx)
- [Code Host Adapters](apps/docs/content/docs/reference/code-host-adapters.mdx)
- [Architecture](apps/docs/content/docs/reference/architecture.mdx)
- [Development](apps/docs/content/docs/reference/development.mdx)
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
