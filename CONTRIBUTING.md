# Contributing

## Setup

```bash
mise run install
```

Run the repository gate before opening a pull request:

```bash
mise run check
```

Run the Action gate after editing GitHub Action behavior, Docker packaging, workflow fixtures, Pi CLI mapping, or PR event handling:

```bash
mise run check-actions
```

See [Development](apps/docs/content/docs/reference/development.mdx) for local e2e and release workflow details.

## Pull requests

Keep changes scoped. In the pull request, include:

- summary of user-visible behavior or docs changed
- CLI, runtime, config, Docker Action, or public API impact
- exact verification commands and results

Use the project language in [docs/CONTEXT.md](docs/CONTEXT.md). Architectural changes should update or add an ADR under [docs/adr](docs/adr).

## Documentation

Keep `README.md` user-facing. Put maintainer workflows in `apps/docs/content/docs/reference/development.mdx`, configuration details in `apps/docs/content/docs/guide/configuration.mdx`, Action usage in `apps/docs/content/docs/guide/github-action.mdx`, and durable decisions in ADRs.
