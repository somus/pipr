# @pipr/docs

This app builds the Pipr documentation at `https://pipr.run/docs`.

## Content ownership

| Content | Canonical source |
| --- | --- |
| User guides, concepts, recipes, and references | `apps/docs/content/docs` |
| Product language | `docs/CONTEXT.md` |
| Architecture decisions | `docs/adr` |
| Contribution, security, and release policy | Root `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md` |
| Generated recipe pages | `packages/runtime/src/recipes` through `apps/docs/scripts/sync-recipes.ts` |

Keep maintainer procedures, implementation maps, and design rationale out of the public docs. Link to one canonical page instead of repeating instructions across guides.

Don't edit generated recipe pages directly. Update the recipe source or generator, then run:

```bash
bun run --cwd apps/docs recipes:sync
```

## Development

Run the complete docs gate from the repository root:

```bash
bun run check:docs
```

Use app-scoped commands while developing:

```bash
bun run --cwd apps/docs dev
bun run --cwd apps/docs content:check
bun run --cwd apps/docs test
bun run --cwd apps/docs build
```

The docs deployment uses `Dockerfile.docs` with the repository root as its build context and serves `apps/docs/.output/public` on port `80`.

Open the [hosted docs](https://pipr.run/docs) or read [CONTRIBUTING.md](../../CONTRIBUTING.md) for repository setup.
