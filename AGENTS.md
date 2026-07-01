# Agent Instructions

This repo owns Pipr: a Bun and Turborepo TypeScript monorepo for Pi-powered GitHub pull request review automation, including the Docker Action, CLI, runtime package, product docs, and local `act` fixtures.

## Workflow

- Start from the linked Linear issue or maintainer direction.
- Keep changes scoped to Pipr's TypeScript package surface, Docker Action, `.pipr/` configuration behavior, docs, and local test fixtures.
- Use [docs/CONTEXT.md](docs/CONTEXT.md) for product language. Use Pipr, `.pipr/config.ts`, `Pipr SDK`, `Pi Agent Runner`, `Review Task`, `Diff Manifest`, `Review Finding`, `Main Review Comment`, and `Inline Review Comment`.
- Treat [docs/adr](docs/adr) as the source for architectural decisions.
- Do not commit real local sessions, secrets, credentials, private logs, unredacted user data, or provider keys.

## Commands

- Use `mise run install` for local dependency setup.
- Use `mise run check` before opening or updating a pull request.
- Use `mise run check-actions` after editing the GitHub Action, Docker Action packaging, workflow fixtures, Pi CLI mapping, or PR event handling.
- Use `bun run fallow` when working on maintainability, dependency hygiene, dead exports, duplication, or complexity.
- Use package-level commands during development when narrower feedback is enough.

## Dependencies And Tools

- Before introducing a package, tool, or GitHub Action, check the latest upstream stable version and use it unless there is a documented reason not to.
- Keep versions pinned through the existing sources of truth: `mise.toml`, `package.json`, `bun.lock`, Docker image tags, and workflow action refs.
- Do not add a runtime dependency when Bun, Node, existing workspace packages, or small local code are enough.
- Prefer Bun APIs in scripts, tests, and e2e harness code where practical. Do not add Node compatibility shims unless a public package contract needs Node.
- Use zod at runtime boundaries and fixture boundary parsing instead of ad hoc object guards.
- Reach for stdlib or Bun first, existing local helpers second, and dependency utilities only when they remove real repeated collection code. Use lodash only when it deletes meaningful repeated collection logic, not for one-off expressions.

## Architecture

- Pipr owns the GitHub pull request runtime. Pi owns agent execution.
- Pi is the only agent runner in the Core MVP.
- Keep Fallow as repo quality tooling only. Do not put Fallow into Pipr's review runtime.
- Keep package public surfaces small. Export only deliberate APIs from package roots.
- Put implementation details behind internal modules. Do not export helpers only for tests or convenience.
- Keep functions intent-level. Do not extract one-line field readers, throw wrappers, boolean aliases, or tiny pass-through helpers unless they are used in 3+ places or enforce a real domain invariant.
- Prefer direct control flow inside workflow functions over chains of tiny local helpers.
- Do not create waterfall helper chains where a parent function delegates to one-use private helpers that only parse, normalize, guard, or wrap a standard call. Keep that logic as local variables and direct control flow in the parent function unless each helper names a real protocol or domain rule.
- Do not add wrappers for simple standard library calls, Bun APIs, lodash helpers, zod parse calls, JSON parse/stringify, string splitting/trimming, object shape checks, or one-expression boolean checks.
- Before adding a private helper, ask whether it would still be worth a named function if used once. If not, keep it inline.
- Keep small helpers only when they define protocol or domain vocabulary, public API boundaries, security-sensitive checks, schema boundary parsers, repeated policy text, or complex logic that would materially hurt readability if inlined.
- Keep Docker Action, CLI command handling, TypeScript config loading, task execution, diff parsing, Pi subprocess execution, review validation, and comment rendering separated by package/module boundary. In review tasks, diff parsing, Pi execution, and review validation stay in Pipr through `ctx.change.diffManifest()` and `ctx.pi.run()`, not userland blocks.
- Keep user configuration in `.pipr/config.ts`. `.pi` is only an internal Pi home inside the Docker image.
- Preserve schema-first reviewer output: validate structured JSON, allow one repair attempt, and drop invalid findings with metadata.
- Keep inline publishing strict: same-range comments only, capped count, invalid finding drops, and marker dedupe.
- Do not add backward compatibility aliases, legacy fallbacks, or migration shims for unreleased APIs unless explicitly requested.
- Use Fallow as a maintainability gate. Fix surfaced duplication, dependency hygiene, dead exports, and complexity instead of broad ignores.
- Fallow ignores must be narrow and temporary. Do not ignore TypeScript source or tests by package folder. Fixture and golden asset ignores are acceptable.

## File Organization

- Keep package root `src` small. Prefer `src/index.ts` plus deliberate public exports.
- Do not import sibling packages through `../package/dist/*`; add a deliberate package export, bin, or e2e entrypoint instead.
- Organize package internals into domain folders such as `src/action`, `src/config`, `src/diff`, `src/pi`, `src/review`, and `src/shared`.
- Name modules by current responsibility. Avoid `legacy`, `compat`, or old-system names for unreleased code.
- Keep Fumadocs content in `apps/docs/content/docs/`; keep source-level product language and ADRs in `docs/CONTEXT.md` and `docs/adr/`.
- Keep local Action e2e harness under `packages/e2e`.
- Test-only helpers should live in the nearest `tests/helpers.ts` or `tests/helpers/*`.

## Test Organization

- Put executable package tests in the nearest `tests/` folder under the source folder they cover: `src/action/commands.ts` -> `src/action/tests/commands.test.ts`.
- Keep the same colocated `tests/` pattern across packages. Use `src/tests` only for package-root files such as `src/index.ts` or `src/types.ts`.
- Do not place `*.test.ts` directly beside runtime files.
- Do not use package-level `test/` or `tests/` directories for executable tests.
- Package-level fixture directories are allowed when they contain assets, not executable tests.
- Prefer public API tests. Add internal tests only when a helper has meaningful independent complexity.
- Preserve fixture behavior unless an intentional divergence is documented in the test.

## TDD And Verification

- Use TDD for behavior changes: write or port one failing behavior test, implement the minimum, then refactor while green.
- Add tests for TypeScript config loading, provider resolution, plan inspection, task execution, diff parsing, schema validation, comment rendering, GitHub publishing, and dry-run boundaries when those areas change.
- Run the narrowest relevant package tests during development.
- Run `mise run check` before opening or updating a PR.
- Run `mise run check-actions` after Action, Docker, workflow, Pi CLI mapping, or event fixture changes.
- If Docker packaging changes, verify the image can run `pi --help` and `pipr action --help`.

## Pull Requests

- Use `.github/PULL_REQUEST_TEMPLATE.md` if present.
- Link the Linear issue.
- State CLI, runtime, config, Docker Action, or public package API impact.
- Include exact verification commands and results.
