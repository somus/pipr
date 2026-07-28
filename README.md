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

Pipr runs AI code review from a TypeScript config in your repository. It supports GitHub, GitLab, Azure DevOps, Bitbucket, Gitea, Forgejo, and Codeberg without tying your review policy to one host.

Use the built-in reviewer, start from a recipe, or compose custom tasks and agents with the typed SDK. Pipr validates findings against the changed code before it publishes review comments.

## Quick start

1. Install Pipr and initialize your repository:

   ```bash
   curl -fsSL https://pipr.run/install.sh | sh
   pipr init
   pipr check
   ```

2. Add the model-provider secret named by the generated config. For the default GitHub setup:

   ```bash
   gh secret set DEEPSEEK_API_KEY
   ```

3. Open or update a change request. Pipr runs from the generated code-host integration.

See the [quickstart](https://pipr.run/docs/guide/quickstart) for model selection, permissions, and a first review.

## What you can configure

- Select models, fallbacks, reasoning levels, timeouts, and retries.
- Limit reviews by path or change-request event.
- Add `@pipr` commands and custom TypeScript tasks.
- Control inline-comment limits and summary publication.
- Run reviews locally before enabling CI.

Start with the [configuration guide](https://pipr.run/docs/guide/configuration), browse the [recipes](https://pipr.run/docs/recipes), or use the [SDK reference](https://pipr.run/docs/reference/sdk-reference).

## Documentation

| Goal | Page |
| --- | --- |
| Understand the review model | [How Pipr works](https://pipr.run/docs/concepts) |
| Configure a repository | [Configuration](https://pipr.run/docs/guide/configuration) |
| Build custom workflows | [Custom tasks](https://pipr.run/docs/guide/custom-tasks) |
| Run Pipr outside CI | [Local runs](https://pipr.run/docs/guide/local-runs) |
| Integrate another code host | [Code-host guides](https://pipr.run/docs/guide) |
| Look up commands and options | [CLI reference](https://pipr.run/docs/reference/cli) |

## Privacy

Pipr runs in your environment or CI runner. It has no hosted control plane.

Pipr sends the configured model provider the repository and change-request context needed for the review, including task instructions and relevant changed code. Provider keys stay in environment variables. Published comments become part of the code host's normal change-request record.

Don't run Pipr on code you aren't permitted to send to the configured model provider. See [Trust and security](https://pipr.run/docs/concepts/trust-security) for the full data and execution model.

## Project

Read [CONTRIBUTING.md](CONTRIBUTING.md) before contributing, [SECURITY.md](SECURITY.md) to report a vulnerability, and [CHANGELOG.md](CHANGELOG.md) for release history.

Pipr is available under the [MIT License](LICENSE).
