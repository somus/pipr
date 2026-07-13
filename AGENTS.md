# Pipr repository instructions

Pipr is a Bun and Turborepo TypeScript monorepo for Pi-powered GitHub pull request review automation. It owns the Docker Action, CLI, SDK, runtime package, product docs, `.pipr/` configuration, and local Action fixtures.

## Architecture and ownership

Pipr owns the GitHub pull request runtime; Pi owns agent execution. Pi is the only agent runner in the Core MVP, while Fallow remains repository quality tooling and must not enter the review runtime.

| Area | Owns | Entry points |
|---|---|---|
| SDK | Public configuration and authoring API | `packages/sdk/src/index.ts` |
| Runtime | Config loading, task execution, diff handling, Pi execution, review validation, and rendering | `packages/runtime/src/` |
| Review validation | Review contract, parse/repair, bounded-range validation, and comment publication | `packages/runtime/src/review/contract.ts`, `packages/runtime/src/review/agent/review-run.ts`, `packages/runtime/src/review/range-validation.ts`, `packages/runtime/src/review/review.ts` |
| CLI and Action | CLI commands and GitHub Action entry | `packages/cli/src/`, `action.yml`, `Dockerfile` |
| PR event dispatch | Action command selection, pull request entry, and GitHub payload parsing | `packages/runtime/src/action/commands.ts`, `packages/runtime/src/action/pull-request-entry.ts`, `packages/runtime/src/hosts/github/event.ts` |
| Action integration tests | Docker image, Pi contract, and `act` fixtures | `packages/e2e/` |
| Product docs | Fumadocs content | `apps/docs/content/docs/` |
| Domain and decisions | Product language and durable architecture | `docs/CONTEXT.md`, `docs/adr/` |

Keep user configuration in `.pipr/config.ts`. `.pi` is only the internal Pi home inside the Docker image.

## Commands and focused checks

| Changed surface | Focused command | Notes |
|---|---|---|
| Initial setup | `mise run install` | Installs Bun dependencies and repository hooks |
| `packages/runtime/src/review/range-validation.ts` or inline-range behavior | `bun test packages/runtime/src/review/tests` | Covers the shared validator, task runtime, review filtering, and GitHub inline mapping consumers; follow with `bun run check:packages` |
| `packages/sdk/**`, `packages/runtime/**`, or `packages/cli/**` | `bun run check:packages` | Builds publishable packages and runs lint, typecheck, tests, formatting, and quality checks |
| `apps/docs/**` or `docs/**` | `bun run check:docs` | Runs docs lint, typecheck, tests, build, formatting, and quality checks |
| Action, Docker packaging, workflow fixtures, Pi CLI mapping, or PR event handling | `mise run check-actions` | Builds the local Docker Action, verifies the Pi contract, and runs `act` fixtures |
| Maintainability, dependency hygiene, dead exports, duplication, or complexity | `bun run fallow` | Run while developing the relevant change |
| Any pull request | `mise run check` | Canonical full-repository gate before opening or updating a PR |

Treat this table as the canonical command map for task planning. Do not reopen root or package manifests solely to confirm a command already listed here; inspect them only when changing scripts, dependencies, or package-specific behavior not covered by the table.

After Docker packaging changes, also verify the image can run `pi --help` and `pipr action --help`.

Local tooling is Bun 1.3.14, `act` 0.2.89, and hk 1.50.0 through mise. Action verification requires Docker. GitHub Action dispatch reads `GITHUB_EVENT_PATH` and `GITHUB_EVENT_NAME`; provider credentials remain external secrets and must not be copied into repository instructions or fixtures.

## Source and generated paths

| Path | Class | Rule |
|---|---|---|
| `dist/**`, `.output/**` | Build output | Do not edit or treat as source; regenerate through the owning build task |
| `coverage/**` | Test output | Do not edit or treat as source; regenerate through tests |
| `apps/docs/content/docs/**` | Documentation source | Edit product documentation here |
| Nearest `src/**/tests/**` | Test source | Put executable package tests beside the source folder they cover |
| Package-level fixture directories | Fixture assets | Assets are allowed; do not place executable tests here |

Never commit real local sessions, secrets, credentials, private logs, unredacted user data, or provider keys.

## Dependencies and public boundaries

- Keep versions pinned through `mise.toml`, `package.json`, `bun.lock`, Docker image tags, and workflow action refs.
- Check the current upstream stable version before adding a package, tool, or GitHub Action.
- Prefer Bun, Node, existing workspace packages, or small local code before adding a runtime dependency.
- Use Zod at runtime and fixture boundaries.
- Do not import sibling packages through `../package/dist/*`; add a deliberate package export, bin, or e2e entry point.
- Keep package roots small and export only deliberate public APIs. Do not export internals only for tests.
- Do not add compatibility aliases, legacy fallbacks, or migration shims for unreleased APIs unless explicitly requested.

## Load-bearing review rules

- Diff parsing, Pi execution, and review validation stay in Pipr through `ctx.change.diffManifest()` and `ctx.pi.run()`, not userland blocks.
- Reviewer output remains schema-first: validate structured JSON, allow one repair attempt, and drop invalid findings with metadata.
- Inline finding `rangeId`, path, and side must match the selected Diff Manifest range. `startLine` must not exceed `endLine`, and both bounds must stay inside that range; a valid strict subrange is allowed.
- Range-validation changes must keep direct validator tests, review/task-runtime fixtures, GitHub inline mapping tests, and deterministic prompt-eval expectations aligned.
- Fallow ignores must remain narrow and temporary. Fixture and golden asset ignores are acceptable; package-wide source or test ignores are not.

## Tests

- Use TDD for behavior changes: add or port one failing behavior test, implement the minimum, then refactor while green.
- Add focused coverage when config loading, provider resolution, plan inspection, task execution, diff parsing, schema validation, comment rendering, GitHub publishing, or dry-run boundaries change.
- Put executable tests in the nearest `tests/` folder under the source folder they cover: `src/action/commands.ts` maps to `src/action/tests/commands.test.ts`.
- Use `src/tests/` only for package-root files such as `src/index.ts` or `src/types.ts`.
- Prefer public API tests. Test internals only when they have meaningful independent complexity.
- Preserve fixture behavior unless the test documents an intentional divergence.

## Pull requests and completion evidence

- Start from the linked Linear issue or maintainer direction.
- Use `.github/PULL_REQUEST_TEMPLATE.md` and link the Linear issue.
- State CLI, runtime, config, Docker Action, docs, release, and public API impact.
- Include exact verification commands and results.
- For Docker changes, include the image command evidence described above.
