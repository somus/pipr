# @usepipr/cli

`@usepipr/cli` provides the `pipr` binary. The CLI parses command flags and
delegates runtime behavior to `@usepipr/runtime`.

Use this package when installing Pipr through npm. The release installer and
GitHub Releases publish compiled CLI binaries for supported platforms.

## Commands

The binary exposes these command groups:

- `pipr init`
- `pipr host-run`
- `pipr check`
- `pipr dry-run`
- `pipr inspect`
- `pipr review`
- `pipr skill`
- `pipr update`
- `pipr version`

Use the CLI reference for option details.

AI agents should start with:

```bash
pipr skill
```

## Updating

For compiled GitHub Release binaries, update the local executable:

```bash
pipr update
```

For package-manager installs, update the package:

```bash
npm install -g @usepipr/cli@latest
bun install -g @usepipr/cli@latest
```

`pipr update` updates only the local CLI executable. It does not update GitHub
Action workflow pins.

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
