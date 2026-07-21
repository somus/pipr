---
name: pipr-setup
description: Install and configure Pipr through a short interview. Use when a user wants an agent to add Pipr to a repository, customize .pipr/config.ts, choose review recipes, configure a supported code host integration, or verify Pipr CLI setup.
disable-model-invocation: true
---

# Pipr setup

Use this skill to add Pipr to a repository and produce a custom Pipr Configuration, not just a stock `pipr init` output.

## Ground first

Inspect before asking:

- Repository instructions and existing AI agent guidance.
- Existing `.pipr/`, generated adapter files, provider secret names, integration mappings, and package manager files. Do not open `.env*` or other files that may contain raw secret values; ask for missing secret names instead.
- Project language, test layout, dependency manifests, generated files, docs, and CI workflows.
- Existing change request review expectations in docs, templates, or contribution guides.

Completion criterion: you know whether this is a new setup or an edit, which files Pipr may touch, and which repo-specific review policies can be inferred without asking.

## Install check

1. Run `command -v pipr` and verify with `pipr --help`. Do not rely on `pipr --version`.
2. If `pipr` is missing, detect the OS and architecture. On Linux and macOS x64 or arm64, ask before running the official release installer for a specific release tag. Do not execute installer scripts from a mutable branch such as `main`.

   ```bash
   PIPR_VERSION="vX.Y.Z"
   installer="$(mktemp)"
   trap 'rm -f "$installer"' EXIT
   curl -fsSL "https://raw.githubusercontent.com/somus/pipr/${PIPR_VERSION}/install.sh" -o "$installer"
   PIPR_VERSION="$PIPR_VERSION" sh "$installer"
   ```

   Replace `vX.Y.Z` with the target release tag. Use the CLI release version when this skill came from `pipr skill`. For a separately installed skill, check Pipr releases and use the latest stable tag unless the user requests another version. The installer verifies release checksums and installs to `~/.local/bin` unless `PIPR_INSTALL_DIR` is set.

3. If the release installer does not support the host OS, use the npm fallback only when Bun is already installed. Reuse the same approved release version and ask before running `npm install -g @usepipr/cli@<version-without-v>`, then verify with `pipr --help`. The npm CLI package uses Bun.
4. For full default setup, check `command -v bun`. `pipr init` creates `.pipr/bun.lock` by running `bun install`. If Bun is missing, ask before installing Bun using the official Bun instructions for the user's OS. Do not silently switch to `--minimal`.

Completion criterion: a `pipr` command is available, and the user has approved any install command that changes their machine.

## Interview gate

Do not run `pipr init` until recipe, model, secrets, triggers, publication behavior, and existing-file handling are explicit.
Defaults are allowed only when the user says to use Pipr defaults, accepts your proposed defaults, or provided equivalent intent.
Combine questions so the interview stays short.

- Existing-file handling: config directory, selected adapter files, and whether existing Pipr files may be edited. Never use `pipr init --force` without explicit approval.
- Recipe or review goal: general review, deep review, bugs, security, quality gate, dependency risk, PR hygiene, diagnostics, briefing, changelog, interactive ask, CI triage, multi-agent review, or durable memory tools.
- Provider policy: GitHub, GitLab, Azure DevOps, Bitbucket, or no generated adapter files; model and code-host secret names; fallback model; and whether local runs should require provider env vars.
- Trigger policy: automatic change request actions, `@pipr` commands, command permissions, local review behavior, and command-only workflows.
- Publication policy: inline comment cap, check runs, aggregate checks, required gates, auto-resolve behavior, and who may trigger verifier replies.
- Repo policy: path include/exclude scopes, generated or lockfile rules, test and docs expectations, package manager quirks, security-sensitive areas, and release-note conventions.

Example compact interview:

```text
Before I initialize Pipr, choose the setup policy:
1. Recipe or goal: default-review, deep-review, bug-hunter, rich-review, fix-suggestions,
   security-sast, quality-gate, diff-diagnostics, pr-hygiene, dependency-risk,
   ci-triage-command, multi-agent-review, plugin-tool-review, pr-briefing,
   interactive-ask, changelog-draft, or a custom workflow.
2. Model: use Pipr default DeepSeek, or specify provider/model/secret env var names.
3. Triggers and publishing: automatic PR review plus @pipr review with capped inline comments, command-only, or merge-gate checks.
4. Code host and existing files: choose github, gitlab, azure-devops, bitbucket,
   or no adapter files; then choose whether to edit existing Pipr files, create new files only, or approve replacement.
```

Completion criterion: recipe, model, secrets, triggers, publication behavior, and repo-specific review policy are explicit enough to write `.pipr/config.ts`.

## Build

Read [recipes.md](references/recipes.md) before selecting a starter recipe. Read [config-patterns.md](references/config-patterns.md) before writing custom task code.

For new setups:

- Choose the smallest matching recipe and run `pipr init --recipe <id> --adapters <adapter-list>` when the user selected an adapter. Omit `--adapters` only for the default GitHub setup.
- Use `github` for `.github/workflows/pipr.yml`, `gitlab` for `.gitlab-ci.yml`, and `azure-devops` or `bitbucket` for trusted-webhook environment templates. Use `--adapters none` only when the user does not want generated adapter files.
- Use `--minimal` only when the user chose a single-file config or Bun cannot be installed.

For existing setups:

- Edit the existing `.pipr/config.ts` and companion files instead of reinitializing.
- Preserve user-authored local imports, secrets, and workflow customizations unless the user approves a replacement.

While customizing:

- Keep config load synchronous. Runtime work belongs inside `pipr.task(...)`.
- Use `pipr.secret({ name })`; never write raw secret values.
- Prefer `pipr.review(...)` until the interview requires multiple Pi calls, command input, custom schemas, plugin tools, explicit checks, or main-comment-only output.
- For custom tasks, pass `{ manifest }` to `ctx.pi.run(...)`; do not interpolate the Diff Manifest into prompts yourself.
- Core already adds bounded change request metadata and schema-aware `suggestedFix` rules to agent prompts. Do not duplicate them in `instructions` or prompt input.
- Emit exactly one final output from each selected task: `ctx.comment(...)` or `ctx.command.reply(...)`.

Completion criterion: the generated or edited Pipr Configuration reflects every interview decision and avoids speculative workflows.

## Verify

Run the narrowest checks that prove the setup:

```bash
pipr inspect
pipr check
```

Use `pipr check --require-env` only when the required provider env vars should already be present. Use `pipr review --base <ref>` only when the user has a safe local base ref, Pi is available, and provider secrets are intentionally exported.

For generated adapter files, inspect the selected integration artifact. Use `pipr dry-run --host <host> --event <path>` only when a real native event fixture is available. Use `pipr webhook serve --host <host>` only after the user has approved the trusted workspace, repository identifier, and webhook secret handling.

Completion criterion: `pipr inspect` shows the expected models, agents, tasks, commands, tools, checks, and limits; `pipr check` succeeds or reports a blocker you can name exactly.

## Report

End with:

- Files created or changed.
- Recipe and major customizations.
- Required code host integration secrets and local env vars by name only.
- Verification commands and results.
- Remaining manual steps, such as adding repository secrets or enabling branch protection.
