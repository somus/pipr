# TypeScript Pipr config

Status: Accepted

Pipr uses repository-local `.pipr/config.ts` as the only supported user authoring surface. There is no YAML/Markdown config loader, migration mode, dual-loader, standalone command registry, or materialized component registry in the MVP.

`pipr init` creates:

- `.pipr/config.ts`
- `.pipr/package.json` and `.pipr/bun.lock` (tier 2 default)
- `.pipr/tsconfig.json` (tier 2 default)

Tier 1 (`pipr init --minimal`) creates only `.pipr/config.ts`. Generated `.pipr/types/pipr-sdk.d.ts` is removed; types come from installed `@usepipr/sdk`. See [0006-installable-config-dependencies.md](./0006-installable-config-dependencies.md).

The config imports `definePipr` and optional explicit `definePlugin` plugins from `@usepipr/sdk`, then registers models, agents, tasks, change-request events, commands, limits, and typed plugin tool handles through the builder API. Config execution is trusted planning code: it should register a runtime plan and should not perform repository reads, model calls, platform calls, or git operations.

For pull request Action runs, Pipr loads `.pipr/config.ts` and local imports from the base commit. Pi still reviews the pull request head. This keeps PR-authored config changes visible in the Diff Manifest but unable to change review settings for the current run.

Pipr-owned internals use `core/*` names for schemas and deterministic review/comment behavior, including `core/pr-review`. Users can compose tasks and agents in TypeScript, but diff creation, Pi call policy, model fallback and retry flow, review validation, stale-head checks, marker dedupe, and code host adapter writes remain inside Pipr.
