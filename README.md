<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/docs/public/images/pipr/pipr-mark-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="apps/docs/public/images/pipr/pipr-mark-light.svg">
    <img alt="Pipr" src="apps/docs/public/images/pipr/pipr-mark.svg" width="120">
  </picture>

  <h1>Pipr</h1>

  <p><strong>Code-owned AI review across code hosts.</strong></p>

  <p>
    <a href="https://github.com/somus/pipr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/somus/pipr/actions/workflows/ci.yml/badge.svg"></a>
    <a href="https://github.com/somus/pipr/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/somus/pipr?label=release"></a>
    <a href="https://www.npmjs.com/package/@usepipr/cli"><img alt="npm CLI version" src="https://img.shields.io/npm/v/@usepipr/cli?label=npm%20cli"></a>
    <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/somus/pipr"></a>
    <a href="https://pipr.run/docs"><img alt="Docs" src="https://img.shields.io/badge/docs-pipr.run-2D3526"></a>
  </p>
</div>

Pipr runs AI review from your repository. It loads `.pipr/config.ts`, builds a deterministic Diff Manifest, runs Pi for structured review output, validates findings against commentable ranges, and publishes one Main Review Comment plus capped Inline Review Comments.

GitHub, GitLab.com, Azure DevOps Services, and Bitbucket Cloud are supported delivery targets. They use Code Host Adapters, so `.pipr/config.ts` stays provider-neutral.

## Why Pipr

Pipr keeps the review runtime and policy in your repository. Compose the workflow in TypeScript:

- `pipr.review(...)` for a tuned default review
- `pipr init --recipe <id>` starters for security SAST, PR briefings, quality gates, dependency risk, and more
- `pipr.task(...)` and `pipr.agent(...)` for custom workflows with typed schemas
- `pipr.command(...)` for `@pipr` commands
- `definePlugin(...)` for typed tools agents can call during review

The runtime owns diff modeling, Pi execution, structured output validation, stale-head checks, and comment publishing. Review policy stays in code you own.

## Quickstart

Install the CLI, create the TypeScript config and default GitHub Action workflow, then validate the setup:

```bash
curl -fsSL https://pipr.run/install.sh | sh
pipr init
pipr check
```

Check the installed CLI version with `pipr --version`. Update a release binary with `pipr update`; for package-manager installs, update `@usepipr/cli` through npm or Bun. Updating the local CLI does not change the GitHub Action pin in `.github/workflows/pipr.yml`.

AI agents should load the version-matched setup skill before configuring a repository:

```bash
pipr skill
```

Set the provider secret referenced by the generated config:

```bash
gh secret set DEEPSEEK_API_KEY
```

`pipr init` creates `.github/workflows/pipr.yml` with the default GitHub Action:

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
      - uses: actions/cache@v4
        with:
          path: /home/runner/work/_temp/_github_home/.bun/install/cache
          key: pipr-bun-${{ hashFiles('.pipr/bun.lock') }}
      - uses: somus/pipr@v0.4.3 # x-release-please-version
        env:
          DEEPSEEK_API_KEY: ${{ secrets.DEEPSEEK_API_KEY }}
          GITHUB_TOKEN: ${{ github.token }}
```

Use `pipr init --adapters none` to create only `.pipr` config files. Run `pipr init --help` for the full option list.

See [Quickstart](https://pipr.run/docs/guide/quickstart) for the full first-run path.

## Configuration

`pipr init` creates `.pipr/config.ts`. The default config registers one review task that runs on change request events, on `@pipr review`, and from local `pipr review --base <ref>` commands:

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
      Review the change request diff for correctness, security,
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

Pipr adds bounded change request metadata, the tool contract, and the output schema to every agent prompt. Review-schema prompts also include Core's finding and `suggestedFix` rules. Keep repository-specific policy in `instructions`; do not repeat those Core contracts.

## Docs

| Goal | Page |
| --- | --- |
| Understand Pipr's core model | [How Pipr works](https://pipr.run/docs/concepts) |
| Add Pipr to a GitHub repository | [Quickstart](https://pipr.run/docs/guide/quickstart) |
| Configure models, scopes, commands, and publication | [Configuration](https://pipr.run/docs/guide/configuration) |
| Start from a generated review workflow | [Recipes](https://pipr.run/docs/recipes) |
| Build custom tasks and agents | [Custom tasks](https://pipr.run/docs/guide/custom-tasks) |
| Look up CLI flags | [CLI reference](https://pipr.run/docs/reference/cli) |
| Look up SDK types and options | [Pipr SDK reference](https://pipr.run/docs/reference/sdk-reference) |
| Understand runtime and publication behavior | [Runtime flow](https://pipr.run/docs/concepts/runtime) |
| Contribute to Pipr | [Contributing](https://pipr.run/docs/project/contributing) |
| Report vulnerabilities | [Security policy](https://pipr.run/docs/project/security) |
| Read release history | [Changelog](https://pipr.run/docs/project/changelog) |

Project language lives in [docs/CONTEXT.md](docs/CONTEXT.md). Architecture decisions live in [docs/adr](docs/adr).

## Packages

| Package | Role |
| --- | --- |
| [`@usepipr/sdk`](packages/sdk) | Public TypeScript authoring SDK for `.pipr/config.ts`. |
| [`@usepipr/runtime`](packages/runtime) | Config loading, diff creation, task execution, validation, and publication planning. |
| [`@usepipr/cli`](packages/cli) | `pipr` binary and command-line entrypoint. |
| [`@pipr/e2e`](packages/e2e) | Private local Action and container test harness. |
| [`@pipr/evals`](packages/evals) | Private prompt-evaluation suite for review behavior. |
| [`@pipr/docs`](apps/docs) | Fumadocs site source for `https://pipr.run/docs`. |

## Status

Pipr is early. CLI binaries ship through [GitHub Releases](https://github.com/somus/pipr/releases), `@usepipr/sdk`, `@usepipr/runtime`, and `@usepipr/cli` ship through npm, and the Docker Action image ships through GHCR.

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
