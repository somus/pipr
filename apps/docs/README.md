# @pipr/docs

`@pipr/docs` is the source app for the Pipr docs hosted at
`https://pipr.run/docs`.

Docs content lives under `apps/docs/content/docs`. Generated paths such as
`.source`, `.output`, `.tanstack`, and `src/routeTree.gen.ts` stay ignored.

GitHub Markdown files remain canonical for project policy pages such as
`CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md`. The docs app may include
reader-friendly adaptations that link back to those source files.

## Commands

```bash
bun run --cwd apps/docs dev
bun run --cwd apps/docs typegen
bun run --cwd apps/docs typecheck
bun run build:docs
```

## Docs

- [Hosted Docs](https://pipr.run/docs)
- [Development](https://pipr.run/docs/reference/development)
