# Contributing

Use this guide when you are changing Pipr itself. For product usage, start with
the [hosted docs](https://pipr.run/docs).

## Setup

Install dependencies through the repo toolchain:

```bash
mise run install
```

This installs Bun workspace dependencies and Git hooks.

## Checks

Run the repository gate before opening or updating a pull request:

```bash
mise run check
```

Run the Action gate after editing any GitHub Action behavior, Docker packaging,
workflow fixtures, Pi CLI mapping, or PR event handling:

```bash
mise run check-actions
```

Use narrower package commands while developing when they prove the change. See
[Development](apps/docs/content/docs/reference/development.mdx) for local e2e,
release, docs, and Docker workflow details.

## Remote cache

CI and release workflows use Turborepo remote caching when these GitHub settings
exist:

```bash
gh secret set TURBO_API
gh secret set TURBO_TOKEN
gh secret set TURBO_REMOTE_CACHE_SIGNATURE_KEY
gh variable set TURBO_TEAM --body pipr
```

Set `TURBO_API` to a deployed
[`ducktors/turborepo-remote-cache`](https://github.com/ducktors/turborepo-remote-cache)
server. `TURBO_TEAM` defaults to `pipr` in CI, but set it explicitly when you
configure the repository.

To run the cache server locally:

```bash
cp turbo-cache.env.example turbo-cache.env
docker compose --env-file turbo-cache.env -f docker-compose.turbo-cache.yml up -d
```

Before sharing a cache server, replace the example `TURBO_TOKEN` and
`TURBO_REMOTE_CACHE_SIGNATURE_KEY` values with long random strings.

## Pull requests

Keep changes scoped to the behavior you are changing. In the pull request,
include:

- a short summary of user-visible behavior or docs changed
- CLI, runtime, config, Docker Action, docs, or public API impact
- exact verification commands and results

Use the project language in [docs/CONTEXT.md](docs/CONTEXT.md). Architectural changes should update or add an ADR under [docs/adr](docs/adr).

## Documentation

Keep `README.md` user-facing. Put docs content in the narrowest matching place:

| Content | Location |
| --- | --- |
| First-run and product overview | `README.md` and `apps/docs/content/docs/index.mdx` |
| Configuration examples | `apps/docs/content/docs/guide/configuration.mdx` |
| GitHub Action usage | `apps/docs/content/docs/guide/github-action.mdx` |
| Maintainer workflows | `apps/docs/content/docs/reference/development.mdx` |
| Durable architecture decisions | `docs/adr` |
| Product vocabulary | `docs/CONTEXT.md` |

When you add or move docs-site pages, update the nearest `meta.json` and run
the docs checks before opening the pull request.
