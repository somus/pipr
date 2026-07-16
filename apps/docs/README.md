# @pipr/docs

`@pipr/docs` is the source app for the Pipr docs hosted at
`https://pipr.run/docs`.

Docs content lives under `apps/docs/content/docs`. Generated paths such as
`.source`, `.output`, `.tanstack`, and `src/routeTree.gen.ts` stay ignored.

GitHub Markdown files remain canonical for project policy pages such as
`CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md`. The docs app may include
reader-friendly adaptations that link back to those source files.

## Commands

Run the canonical docs gate from the repository root:

```bash
bun run check:docs
```

Use app-scoped commands while developing the docs site:

```bash
bun run --cwd apps/docs dev
bun run --cwd apps/docs typegen
bun run --cwd apps/docs typecheck
bun run --cwd apps/docs test
bun run --cwd apps/docs build
```

## Dokploy

Use the dedicated docs Dockerfile when deploying this app through Dokploy:

| Setting | Value |
| --- | --- |
| Build Type | `Dockerfile` |
| Dockerfile Path | `Dockerfile.docs` |
| Docker Context Path | `.` |
| Domain port | `80` |

The image builds `@pipr/docs` and serves `apps/docs/.output/public` through
Nginx. The existing root `Dockerfile` remains the Pipr Action image.

## Docs

- [Hosted Docs](https://pipr.run/docs)
- [Development](https://pipr.run/docs/project/development)
