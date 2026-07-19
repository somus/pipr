# Pipr product language

Use these terms consistently in product docs, code comments, issues, and pull requests.

## Terms

**Pipr**:
The code review automation product that reviews code host change requests through Pi-powered agents.
_Avoid_: legacy product names

**Pipr Core**:
The lean runtime surface Pipr owns: diff modeling, Pi execution, review validation, and comment publishing. Default review, recipes, custom tasks, commands, and plugins compose on top of this core in user config.
_Avoid_: framework, all-in-one review bot, per-workflow runtime forks

**Pipr Configuration**:
The repository-local TypeScript config under `.pipr/config.ts`.
_Avoid_: legacy configuration roots, `.pi/`

**Trusted Base Config**:
The `.pipr/config.ts` and local imports loaded from the change request base commit for hosted runs.
_Avoid_: PR-authored runtime settings

**Code Host Adapter**:
The internal provider boundary for native events, permissions, checkout, comment publication, and inline location mapping.
GitHub, GitLab.com, Azure DevOps Services, and Bitbucket Cloud are supported.
_Avoid_: GitHub runtime, provider-specific user config

**Change Request**:
The provider-neutral review target. GitHub, Bitbucket Cloud, and Azure DevOps Services map this to a pull request; GitLab.com maps it to a merge request.
_Avoid_: GitHub-only pull request when describing core runtime

**TypeScript Config**:
The single supported runtime authoring surface. `pipr init` creates `.pipr/config.ts` by default as part of a tier-2 Bun package (`.pipr/package.json`, `.pipr/bun.lock`, `.pipr/tsconfig.json`). `pipr init --minimal` scaffolds tier 1 (config file only).
_Avoid_: hidden runtime defaults

**Pipr SDK**:
The public builder API imported from `@usepipr/sdk`.
_Avoid_: YAML component registry

**@pipr**:
The code host command mention for task-owned commands such as `@pipr review`.
_Avoid_: bot aliases

**Pi Agent Runner**:
The agent execution boundary where Pi runs reviewer prompts and returns structured output to Pipr.
_Avoid_: publisher

**Task Input**:
A typed value parsed from a command or local entrypoint and passed to a `pipr.task()` callback.
_Avoid_: environment variable, hidden prompt state

**Review Task**:
A `pipr.task()` callback that gathers context, runs agents, and contributes review output.
_Avoid_: YAML workflow, block graph

**Review Run**:
The Pipr-owned path used by `ctx.change.diffManifest()` and `ctx.pi.run()`.
_Avoid_: user-authored diff or validation block

**Pipr Result**:
The strict, versioned, public outcome shared by Action output, local JSON, and persisted webhook history. A Pipr Result contains safe run and publication summaries, never runtime plans, native comment identities, credentials, or raw errors.
_Avoid_: provider-specific output payload, internal runtime dump

**Diff Manifest**:
The compact changed-code model that defines files, hunks, and ranges where review findings may be anchored.
_Avoid_: raw diff

**Condensed Diff Manifest**:
A size-reduced prompt form that preserves mapping fields while allowing bounded follow-up reads.
_Avoid_: lossy location model, model-owned diff parsing

**Pipr Diff Read Tool**:
A Pipr-attached Pi tool for bounded reads over trusted Diff Manifest data and base/head snapshots.
_Avoid_: plugin tool, GitHub API tool, shell access

**Review Finding**:
An actionable issue found in a change request and anchored to a validated diff range.
_Avoid_: nit, alert

**Main Review Comment**:
The single change request comment that summarizes Pipr's review and metadata.
_Avoid_: summary post

**Inline Review Comment**:
A change request review comment anchored to one validated diff range.
_Avoid_: annotation

**Comment Publishing**:
The Pipr-owned reducer and code host adapter writer for Main Review Comments and Inline Review Comments.
_Avoid_: task-authored code host comment writes
