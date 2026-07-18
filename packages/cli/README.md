# @usepipr/cli

`@usepipr/cli` provides the `pipr` binary. The CLI parses command flags and
delegates runtime behavior to `@usepipr/runtime`.

Use this package when installing Pipr through npm. The release installer and
GitHub Releases publish compiled CLI binaries for supported platforms.

The npm package executes with Bun and requires Bun 1.3.14 or newer. Compiled
GitHub Release binaries are self-contained and do not require a system Bun
installation.

## Commands

The binary exposes these command groups:

- `pipr init`
- `pipr host-run`
- `pipr webhook serve`
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

`pipr update` updates only the local CLI executable. It does not update a
repository's generated integration files.

## Technical notes

- Package build emits `dist/main.mjs`.
- Release binary builds run through `packages/cli/build-release.ts`.
- The package publishes the `pipr` bin through npm and release artifacts through
  GitHub Releases.

## Local checks

```bash
bun run --cwd packages/cli check
bun run build:release:cli
```

## Docs

- [CLI reference](https://pipr.run/docs/reference/cli)
- [Quickstart](https://pipr.run/docs/guide/quickstart)
- [Local runs](https://pipr.run/docs/guide/local-runs)
