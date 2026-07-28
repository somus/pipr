# @usepipr/cli

`@usepipr/cli` provides the `pipr` command. Install this package when you manage Pipr through npm or Bun.

## Quick start

1. Install the CLI with Bun 1.3.14 or newer:

   ```bash
   bun install -g @usepipr/cli
   ```

2. Initialize and validate a repository:

   ```bash
   pipr init
   pipr check
   ```

Compiled binaries are also available from [GitHub Releases](https://github.com/somus/pipr/releases) and don't require Bun.

## Common commands

- `pipr init` creates a config and code-host integration.
- `pipr check` validates the config and environment.
- `pipr review` runs a local review.
- `pipr dry-run` previews a hosted event without publishing.
- `pipr webhook serve` runs the webhook service.
- `pipr skill` prints version-matched setup guidance for coding agents.
- `pipr update` updates a compiled release binary.

Use `pipr --help` or the [CLI reference](https://pipr.run/docs/reference/cli) for every command and option.

For package-manager installs, update the package with `bun install -g @usepipr/cli@latest`. Updating the CLI doesn't change integration files already committed to a repository.

See the [quickstart](https://pipr.run/docs/guide/quickstart) or [local runs guide](https://pipr.run/docs/guide/local-runs) for complete workflows.
