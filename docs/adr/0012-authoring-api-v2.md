# ADR 0012: Authoring API v2

## Status

Accepted.

## Context

Only two of fifteen official recipes used `pipr.review()`. The rest wrote custom tasks and each
re-implemented severity ranking, inline-comment caps, Markdown escaping, check gating, trigger
pairs, and suggested-fix validation. A design review compared a larger declarative review object
with task-level helpers and rejected the declarative object: it became a second orchestration
language with weak inference and no honest ejection path.

## Decision

Ordinary tasks are the primary authoring model. Pipr adds runtime-owned helpers that every task can
compose:

- `pipr.finding({...})` extends the core finding with user-owned Zod fields. Enum fields become
  ledger facets. Pipr never hardcodes a severity or category vocabulary.
- `ctx.review.select(findings, { rank })` validates, deduplicates, ranks by an enum field's
  declaration order or a comparator, and applies the inline-comment cap.
- `ctx.check.gate(findings, { failOn })` or a gate function sets the task check.
- `md` escapes interpolated values; `md.raw` marks trusted Markdown.
- `ctx.change.diff()` returns a typed changed-code context value instead of the reserved
  `manifest` input field.
- `ctx.pi.all()` runs agents in parallel.
- `pipr.task({ on })` declares change request and command triggers; `pipr.command()` remains for
  additional commands on a task.
- `pipr.model("provider/model")` reads the provider's standard API key variable unless `apiKey` is
  given.

`pipr.review()` is a thin single-call preset over these helpers. An optional summary agent adds a
second call. A new declarative option is added only when it serves at least two official recipes.

## Consequences

This is a breaking change to the unreleased SDK with no compatibility path. `pipr.on.changeRequest`,
the reserved `manifest` field, `retry` agent options, and the two-agent default review are removed.
Invalid-output repair is fixed at one attempt.
