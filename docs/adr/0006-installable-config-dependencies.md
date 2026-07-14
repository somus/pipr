# Installable config dependencies

Status: Accepted

Pipr config scales from a single TypeScript file to a full Bun package, mirroring Pi agent extension philosophy. Both tiers are first-class:

- **Tier 1 — single file:** `.pipr/config.ts` alone. No `package.json`, no install step. The runtime provides the SDK module. Editor types can come from `@usepipr/sdk` installed at the repo root.
- **Tier 2 — full package:** `.pipr/package.json` + `.pipr/bun.lock` unlock third-party npm imports and self-contained editor types. `pipr init` scaffolds this layout by default; `pipr init --minimal` scaffolds tier 1.

## Runtime SDK override

The runtime always overrides `@usepipr/sdk` with the image or CLI built-in SDK via a typed stub in temp `node_modules`. A user's npm install of `@usepipr/sdk` is types and editor support only. `pipr check` typechecks against the effective runtime SDK declaration from that stub, so contract breaks surface before merge.

## Installs

- Bun only: when `.pipr/package.json` declares installable dependencies beyond runtime-provided packages (`@usepipr/sdk`, `@types/bun`), including the default scaffolded `typescript`, the loader projects those runtime-provided packages out of the temp config lockfile before loading.
- Bun produces the projection in lockfile-only mode. Pipr requires retained metadata and package entries to remain unchanged; Bun may introduce a new install-location key only when its complete package tuple, including resolution and integrity, already exists in the committed lockfile. The real install then runs with `bun install --frozen-lockfile --ignore-scripts` and normal integrity verification.
- Default tier-2 scaffolds install `typescript` from the validated lockfile projection while keeping `@usepipr/sdk` overridden by the runtime stub; real third-party deps install from the same base-commit lockfile.
- Init runs non-frozen `bun install` in `.pipr/` to produce `bun.lock`. A `bun` binary on PATH is required for init and for configs with third-party deps.

## Security

- Install scripts are disabled (`--ignore-scripts`).
- GitHub Action runs load `.pipr/**` from the base commit; `package.json` and `bun.lock` are part of trusted config. The runtime may delete entries or re-key an unchanged committed package tuple when projecting out runtime-provided packages, but it rejects new or changed dependency data before the frozen install.
- `.pipr/node_modules` is gitignored and excluded from config copy; the loader installs into temp dirs instead.

## Supersedes

The generated `.pipr/types/pipr-sdk.d.ts` approach described in [0003-typescript-pipr-config.md](./0003-typescript-pipr-config.md) is superseded by installable `@usepipr/sdk` types in tier 2 and optional root-level SDK devDependency in tier 1.
