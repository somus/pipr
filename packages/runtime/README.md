# @usepipr/runtime

`@usepipr/runtime` owns Pipr's config loading, Action and local command
execution, Diff Manifest creation, Pi execution, review validation, and
publication planning.

Most users should interact with this package through the `pipr` CLI or the
GitHub Action. Repository configs should import from `@usepipr/sdk`.

## Technical Notes

- The package root exports command APIs for init, Action runs, dry runs,
  config checks, plan inspection, and local review.
- `./runtime-tools-extension` is the static Pi runtime tools extension loaded
  during condensed Diff Manifest runs.
- `./internal/testing` is an unsupported test surface for Pipr's private e2e
  harness.
- The build emits ESM and declaration files to `dist`.

## Source Map

| Path | Responsibility |
| --- | --- |
| `src/action` | CLI and GitHub Action command orchestration |
| `src/config` | `.pipr/config.ts` loading, init files, recipes, and SDK stubs |
| `src/diff` | Diff Manifest parsing, projection, ranges, and path filters |
| `src/pi` | Pi subprocess contract, runtime tools, and provider wiring |
| `src/review` | Task execution, agent prompts, validation, comments, and publication plans |
| `src/hosts` | Code host adapters for GitHub and local runs |

## Local Checks

```bash
bun run --cwd packages/runtime test:config-init
bun run --cwd packages/runtime test:config-loader
bun run --cwd packages/runtime test:core
bun run --cwd packages/runtime check
```

## Docs

- [Runtime Guide](https://pipr.run/docs/guide/runtime)
- [Comments and Findings](https://pipr.run/docs/guide/comments)
- [Architecture](https://pipr.run/docs/reference/architecture)
- [Trust and Security](https://pipr.run/docs/guide/trust-security)
