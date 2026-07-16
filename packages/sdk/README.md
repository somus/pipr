# @usepipr/sdk

`@usepipr/sdk` is the public TypeScript authoring SDK for `.pipr/config.ts`.
Use it to define Pipr models, reviewers, tasks, commands, tools, schemas, and
publication settings.

This is the package user configs import directly.

## Technical notes

- The package root exports `definePipr`, `definePlugin`, `z`, schemas, prompt
  helpers, review parsers, and public config, task, diff, schema, and agent
  types.
- The `./internal` export is for Pipr runtime integration. User configs should
  import from the package root.
- The build emits ESM and declaration files to `dist`.

## Local checks

```bash
bun run --cwd packages/sdk check
bun run --cwd packages/sdk build
```

## Docs

- [Pipr SDK reference](https://pipr.run/docs/reference/sdk-reference)
- [Configuration](https://pipr.run/docs/guide/configuration)
