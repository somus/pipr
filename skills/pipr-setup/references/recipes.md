# Pipr recipe selection

Choose the smallest recipe that matches the requested workflow, then customize `.pipr/config.ts`.

## Starter recipes

| Recipe | Use When | Main Customization Points |
| --- | --- | --- |
| `default-review` | The user wants a bounded general change request reviewer. | Review instructions, inline cap, command pattern, path scope. |
| `deep-review` | The user wants broader review coverage and accepts extra model calls on large or concurrency-sensitive changes. | Sharding thresholds, concurrency signals, latency and cost limits. |
| `bug-hunter` | The user wants correctness defects, edge cases, races, regressions, and missing tests. | Excluded docs paths, fallback model, inline cap. |
| `rich-review` | The user wants a structured review with grouped findings and explicit coverage. | Finding categories, summary format, inline cap. |
| `fix-suggestions` | The user wants concise, exact suggested replacements when a finding has a small fix. | Suggested-fix policy, inline cap, review scope. |
| `security-sast` | The user wants concrete security findings with severity, category, and attack path. | Risk categories, required check policy, security path scopes. |
| `quality-gate` | The user wants a merge gate for blocking correctness, reliability, security, or test risks. | Required check name, fail criteria, auto-resolve policy. |
| `diff-diagnostics` | The workflow maps diagnostics into Pipr Inline Review Comments. | Diagnostic schema, path and range mapping, external diagnostic source. |
| `pr-hygiene` | The user wants tests, docs, lockfile, generated-file, and change-size hygiene. | Hygiene rules, required or advisory check, changed-file rules. |
| `dependency-risk` | Dependency manifests and lockfiles need supply-chain or upgrade-risk review. | Manifest patterns, migration notes, package manager expectations. |
| `ci-triage-command` | Maintainers want to paste CI logs into an `@pipr` command. | Command pattern, permission, log parsing expectations. |
| `multi-agent-review` | Specialists should review security, tests, and maintainability before aggregation. | Specialist list, timeout, cost controls, aggregation policy. |
| `plugin-tool-review` | Reviewer agents need custom tools or durable project memory. | Tool secrets, storage provider, safety rules for stored memory. |
| `pr-briefing` | The user wants a PR-Agent describe-style main comment. | Briefing sections, walkthrough format, changed-area taxonomy. |
| `interactive-ask` | Reviewers need a free-form `@pipr ask <question...>` command. | Command permission, prompt boundaries, prior review usage. |
| `changelog-draft` | Maintainers want release-note style command responses. | Changelog format, audience, release channels. |

## Selection rules

- Start from `default-review` unless another row directly matches the user's main workflow.
- Prefer one custom task over multiple independent tasks when the final output should be one coherent Main Review Comment.
- Prefer command-only recipes when the user wants explicit maintainer-triggered analysis and no automatic review.
- Prefer `quality-gate` only when the user wants branch protection semantics. Otherwise keep checks advisory.
- Prefer `plugin-tool-review` only when the interview identifies durable context or external lookup tools that cannot fit in prompt instructions.
- Combine recipes by editing config, not by running `pipr init` repeatedly. `pipr init` is a starter, not a merger.

## Init commands

```bash
pipr init
pipr init --recipe deep-review
pipr init --recipe security-sast
pipr init --recipe multi-agent-review --adapters none
pipr init --minimal
```

Use `pipr init --force` only after the user explicitly approves replacing existing Pipr files.
