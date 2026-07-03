# @usepipr/cli

`@usepipr/cli` provides the `pipr` binary. The CLI parses command flags and
delegates runtime behavior to `@usepipr/runtime`.

## Commands

The binary exposes these command groups:

- `pipr init`
- `pipr action`
- `pipr check`
- `pipr dry-run`
- `pipr inspect`
- `pipr review`

Use the CLI reference for option details.

## Technical Notes

- Package build emits `dist/main.mjs`.
- Release binary builds run through `packages/cli/build-release.ts`.
- The package publishes the `pipr` bin through npm and release artifacts through
  GitHub Releases.

## Local Checks

```bash
bun run --cwd packages/cli check
bun run build:release:cli
```

## Docs

- [CLI Reference](https://pipr.run/docs/reference/cli)
- [Quickstart](https://pipr.run/docs/guide/quickstart)
- [Local Runs](https://pipr.run/docs/guide/local-runs)
